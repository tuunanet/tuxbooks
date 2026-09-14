use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use crate::error::AppError;
use crate::repository::library_locations;
use crate::rpc::EventEmitter;
use crate::services::book_importer::{import_directory, import_file, ImportReport};
use crate::services::library_reconciler::{reconnect_book as reconnect, LibraryChange};
use crate::{covers_dir, pdfium_library_dirs, AppState};

/// Progress events are batched: the renderer coalesces its commits anyway,
/// so 1,500 individual IPC events per import are pure overhead (issue #61).
/// A batch flushes at `EVENT_BATCH_BOOKS` books or `EVENT_BATCH_WINDOW_MS`,
/// whichever comes first; the caller flushes the remainder after the run.
const EVENT_BATCH_BOOKS: usize = 25;
const EVENT_BATCH_WINDOW_MS: u128 = 250;

/// Wire shape of one batched `import-progress` event.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgressBatch {
    books: Vec<crate::domain::Book>,
}

/// Accumulates persisted books and emits them as batched `import-progress`
/// events. `Mutex` (not `RefCell`) because the importer requires the
/// callback to be `Sync`.
struct ProgressBatcher<'a> {
    events: &'a EventEmitter,
    books: Vec<crate::domain::Book>,
    last_flush: Instant,
}

impl<'a> ProgressBatcher<'a> {
    fn new(events: &'a EventEmitter) -> Self {
        Self {
            events,
            books: Vec::new(),
            last_flush: Instant::now(),
        }
    }

    fn push(&mut self, book: crate::domain::Book) {
        self.books.push(book);
        if self.books.len() >= EVENT_BATCH_BOOKS
            || self.last_flush.elapsed().as_millis() >= EVENT_BATCH_WINDOW_MS
        {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if self.books.is_empty() {
            return;
        }
        self.events.emit(
            "import-progress",
            &ImportProgressBatch {
                books: std::mem::take(&mut self.books),
            },
        );
        self.last_flush = Instant::now();
    }
}

/// Scan the directory at `path` for EPUB and PDF files and import them into
/// the library. Persisted books are streamed to the UI as batched
/// `import-progress` events so books and covers appear while the scan is
/// still running.
///
/// The directory is also registered as a watched library location, so after
/// this scan the filesystem watcher keeps it synchronized (milestone 3).
pub async fn scan_library(
    state: &AppState,
    events: &EventEmitter,
    path: String,
) -> Result<ImportReport, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("library path is empty".into()));
    }
    let root = PathBuf::from(path);
    let covers = covers_dir(&state.db_path);
    let pdfium_dirs = pdfium_library_dirs();
    let batch = Mutex::new(ProgressBatcher::new(events));
    let report = import_directory(&state.db, &root, &covers, &pdfium_dirs, &|book| {
        batch.lock().unwrap().push(book.clone());
    })
    .await?;
    batch.lock().unwrap().flush();

    library_locations::add_location(&state.db, &root.to_string_lossy()).await?;
    state.watcher.watch(&root);
    Ok(report)
}

/// Import a mixed batch of files and/or folders (milestone 10). Folders are
/// scanned and registered as watched library locations exactly like
/// `scan_library`; plain files are imported in place and stay unwatched
/// (a stray single file does not turn its folder into a library root).
/// Persisted books stream out as batched `import-progress` events;
/// per-path failures come back in the report so the UI can surface them
/// honestly.
pub async fn import_paths(
    state: &AppState,
    events: &EventEmitter,
    paths: Vec<String>,
) -> Result<ImportReport, AppError> {
    let covers = covers_dir(&state.db_path);
    let pdfium_dirs = pdfium_library_dirs();
    let batch = Mutex::new(ProgressBatcher::new(events));
    let emit_progress = |book: &crate::domain::Book| {
        batch.lock().unwrap().push(book.clone());
    };

    let mut report = ImportReport::default();
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        if path.as_os_str().is_empty() {
            report
                .failed
                .push(crate::services::book_importer::FailedImport {
                    path: raw,
                    error: "path is empty".into(),
                });
            continue;
        }
        if path.is_dir() {
            let root = path.clone();
            match import_directory(&state.db, &root, &covers, &pdfium_dirs, &emit_progress).await {
                Ok(mut folder_report) => {
                    report.imported += folder_report.imported;
                    report.updated += folder_report.updated;
                    report.skipped += folder_report.skipped;
                    report.failed.append(&mut folder_report.failed);
                    if library_locations::add_location(&state.db, &root.to_string_lossy())
                        .await
                        .is_ok()
                    {
                        state.watcher.watch(&root);
                    }
                }
                Err(err) => report
                    .failed
                    .push(crate::services::book_importer::FailedImport {
                        path: path.to_string_lossy().into_owned(),
                        error: err.to_string(),
                    }),
            }
        } else if path.is_file() {
            match import_file(&state.db, &path, &covers, &pdfium_dirs).await {
                Ok(Some(outcome)) => {
                    if outcome.inserted {
                        report.imported += 1;
                    } else {
                        report.updated += 1;
                    }
                    emit_progress(&outcome.book);
                }
                Ok(None) => report
                    .failed
                    .push(crate::services::book_importer::FailedImport {
                        path: path.to_string_lossy().into_owned(),
                        error: "not a supported book file (.epub/.pdf)".into(),
                    }),
                Err(err) => report
                    .failed
                    .push(crate::services::book_importer::FailedImport {
                        path: path.to_string_lossy().into_owned(),
                        error: err.to_string(),
                    }),
            }
        } else {
            report
                .failed
                .push(crate::services::book_importer::FailedImport {
                    path: raw,
                    error: "path does not exist".into(),
                });
        }
    }
    batch.lock().unwrap().flush();
    Ok(report)
}

/// Reconnect an unavailable book to a new file chosen by the user. The book
/// keeps its id — and therefore metadata, collections, and reading progress —
/// while path and parsed metadata are refreshed from the located file.
pub async fn reconnect_book(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
    path: String,
) -> Result<crate::domain::Book, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("book path is empty".into()));
    }
    let covers = covers_dir(&state.db_path);
    let pdfium_dirs = pdfium_library_dirs();
    let book = reconnect(
        &state.db,
        book_id,
        std::path::Path::new(&path),
        &covers,
        &pdfium_dirs,
    )
    .await?;
    events.emit(
        "library-changed",
        &LibraryChange::Changed {
            book: Box::new(book.clone()),
        },
    );
    Ok(book)
}
