use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use crate::commands::books::delete_book_and_notify;
use crate::commands::emit_changed_book;
use crate::domain::{StartupRecovery, StorageStats};
use crate::error::AppError;
use crate::repository::books;
use crate::repository::library_locations;
use crate::repository::storage;
use crate::rpc::EventEmitter;
use crate::services::book_importer::{import_directory, ImportReport};
use crate::services::library_reconciler::reconnect_book as reconnect;
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

/// Wire shape of one `unwatch-progress` event: `removed` books are gone out
/// of the `total` the dialog promised to remove.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UnwatchProgress {
    removed: usize,
    total: usize,
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
/// The directory is also registered as a watched library location before
/// its books are imported, so an interrupted scan leaves the folder watched
/// and startup catch-up finishes it (milestone 3).
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
    let mut report = ImportReport::default();
    register_and_import_folder(
        state,
        &root,
        &covers,
        &pdfium_dirs,
        &|book| {
            batch.lock().unwrap().push(book.clone());
        },
        &mut report,
    )
    .await?;
    batch.lock().unwrap().flush();
    Ok(report)
}

/// Import a mixed batch of files and/or folders (milestone 10). Every folder
/// is registered and watched before its books land, so an interrupted import
/// leaves a watched folder that startup catch-up finishes. A plain file's
/// parent gets the same folder treatment and the scan imports the picked
/// file with its siblings (ADR 0009), so every catalog book comes from a
/// watched folder. Registering an already-watched folder is idempotent: no
/// duplicate rows, no error, and no second disclosure. Persisted books
/// stream out as batched `import-progress` events; per-path failures come
/// back in the report so the UI can surface them honestly, and every folder
/// this run newly watched is listed in the report so the UI can disclose it.
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
    // Folder scans run after every explicit entry is in hand, so a drop of
    // ten books from one folder scans that folder once instead of ten times.
    let mut folders: Vec<PathBuf> = Vec::new();
    let mut seen_folders: HashSet<PathBuf> = HashSet::new();
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
            queue_folder(&mut folders, &mut seen_folders, path);
        } else if path.is_file() {
            // A picked file is imported by its parent's scan. Reject a
            // non-book now, so a stray file never watches its folder only
            // to fail inside the scan.
            if path
                .extension()
                .and_then(crate::domain::BookFormat::from_extension)
                .is_none()
            {
                report
                    .failed
                    .push(crate::services::book_importer::FailedImport {
                        path: path.to_string_lossy().into_owned(),
                        error: "not a supported book file (.epub/.pdf)".into(),
                    });
                continue;
            }
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    queue_folder(&mut folders, &mut seen_folders, parent.to_path_buf());
                }
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
    for folder in folders {
        if let Err(err) = register_and_import_folder(
            state,
            &folder,
            &covers,
            &pdfium_dirs,
            &emit_progress,
            &mut report,
        )
        .await
        {
            report
                .failed
                .push(crate::services::book_importer::FailedImport {
                    path: folder.to_string_lossy().into_owned(),
                    error: err.to_string(),
                });
        }
    }
    batch.lock().unwrap().flush();
    Ok(report)
}

/// Add a folder to the scan queue once, preserving the order the caller
/// named it.
fn queue_folder(folders: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, folder: PathBuf) {
    if seen.insert(folder.clone()) {
        folders.push(folder);
    }
}

/// Register `root` as a watched location, then import its books — the one
/// folder treatment both folder imports and picked files' parents get (ADR
/// 0009). Registration comes first so a quit during the scan leaves a
/// watched folder, not catalog rows no location owns; the next launch's
/// catch-up finishes the import. A scan that fails keeps the watch for the
/// same reason: it is visible and retryable, and removing it would strand
/// whatever rows already landed. Book counts and per-path failures merge
/// into `report`; a folder this run newly registered is disclosed in
/// `report.watched`. Registration is idempotent: an already-watched folder
/// produces no disclosure and no duplicate row.
async fn register_and_import_folder(
    state: &AppState,
    root: &Path,
    covers: &Path,
    pdfium_dirs: &[PathBuf],
    emit_progress: &(dyn Fn(&crate::domain::Book) + Send + Sync),
    report: &mut ImportReport,
) -> Result<(), AppError> {
    register_and_watch(state, root, report).await?;
    let mut folder_report =
        import_directory(&state.db, root, covers, pdfium_dirs, emit_progress).await?;
    report.imported += folder_report.imported;
    report.updated += folder_report.updated;
    report.skipped += folder_report.skipped;
    report.failed.append(&mut folder_report.failed);
    Ok(())
}

/// Register `root` as a watched library location, start the filesystem
/// watcher on it, and disclose a first-time registration in `report.watched`
/// — one tail every import path shares, so the disclosure rule lives in one
/// place. Registration is idempotent: an already-watched folder produces no
/// disclosure and no duplicate row.
///
/// A folder already inside a watched folder is not registered at all (ADR
/// 0010). The folder above watches the whole subtree recursively, so a row
/// of its own would add nothing and could never be unwatched on its own. It
/// is disclosed in `report.covered` instead, so importing one still says
/// where its books came from.
async fn register_and_watch(
    state: &AppState,
    root: &Path,
    report: &mut ImportReport,
) -> Result<(), AppError> {
    let root = root.to_string_lossy().into_owned();
    if covered_by_watched_ancestor(&state.db, &root).await? {
        if !report.covered.contains(&root) {
            report.covered.push(root);
        }
        return Ok(());
    }
    // Add the parent before dropping the nested rows it now covers. If the
    // process dies between the two, the list briefly holds a nested entry
    // but every book still has a watched owner; the reverse order would
    // orphan the descendants' books during the gap.
    if library_locations::add_location(&state.db, &root).await? {
        report.watched.push(root.clone());
    }
    // A watched folder inside another adds nothing (ADR 0010). Its row goes
    // without a purge and its books stay, owned by this folder from here on.
    for gone in library_locations::collapse_descendants(&state.db, &root).await? {
        state.watcher.unwatch(Path::new(&gone));
    }
    state.watcher.watch(Path::new(&root));
    Ok(())
}

/// True when `path` is already inside a watched folder, which watches the
/// whole subtree recursively and so needs no row of its own (ADR 0010). A
/// sibling sharing a string prefix is never inside it, since the split is
/// on a path separator.
async fn covered_by_watched_ancestor(pool: &SqlitePool, path: &str) -> Result<bool, AppError> {
    let registered = library_locations::list_locations(pool).await?;
    Ok(registered
        .iter()
        .any(|candidate| candidate != path && library_locations::is_under(path, candidate)))
}

/// Unwatch one or more folders: the rows leave the watch list, every book
/// the folders own leaves the catalog, and the filesystem watcher stops
/// observing those paths. The purge runs the same delete cascade as the
/// library's own Remove, so progress, collections, and annotations go with
/// the row, and every removal announces itself through the existing
/// `library-changed` event so the library view updates without a restart.
/// Batched `unwatch-progress` events report how many of the promised books
/// are gone while the purge runs; the artwork cache is swept once at the
/// end instead of once per book. Files on disk are never touched. Returns
/// how many folders were actually listed.
///
/// A folder inside another watched folder is refused (ADR 0010). The folder
/// above watches the whole subtree recursively, so the books this unwatch
/// purges would come straight back on the next modify, now as a row of the
/// folder above with a new id and the progress and annotations gone. The
/// watch list is kept flat, so the settings view never offers such a path;
/// this refuses the case for a caller that reaches the command directly.
pub async fn unwatch_locations(
    state: &AppState,
    events: &EventEmitter,
    paths: Vec<String>,
) -> Result<usize, AppError> {
    let mut roots = Vec::with_capacity(paths.len());
    for raw in &paths {
        let path = raw.trim();
        if path.is_empty() {
            return Err(AppError::InvalidInput("folder path is empty".into()));
        }
        roots.push(path.to_string());
    }

    // Read once, while every row still stands, so the refusal reasons about
    // the watch list the user is looking at.
    let registered = library_locations::list_locations(&state.db).await?;

    for root in &roots {
        // The shallowest folder above it, which is the one the dialog would
        // name: taking that folder takes everything between the two, so
        // naming a deeper one would offer a move that leaves the hole open.
        let ancestor = registered
            .iter()
            .filter(|candidate| {
                **candidate != *root && library_locations::is_under(root, candidate)
            })
            .min_by_key(|candidate| candidate.len());
        if let Some(ancestor) = ancestor {
            if !roots.iter().any(|kept| kept == ancestor) {
                return Err(AppError::InvalidInput(format!(
                    "{root} is inside the watched folder {ancestor}, which still watches \
                     everything under it; unwatch {ancestor} instead"
                )));
            }
        }
    }

    // Which books these folders own has to be settled before any row goes:
    // the dialog counts each folder with `storage_stats`, and that count is
    // the promise "these N books are removed". Ownership flips the moment a
    // row is deleted, so the removal set is read while the rows still stand.
    let mut doomed = Vec::new();
    for path in &roots {
        for book in books::books_owned_by(&state.db, path).await? {
            doomed.push(book.id);
        }
    }

    // Stop the taps first: a row left behind is visible and retryable, a
    // watch left behind would keep syncing a folder the user just left. The
    // whole set goes as one operation so a cascaded subfolder is not
    // re-registered on its way out.
    let dying: Vec<PathBuf> = roots.iter().map(PathBuf::from).collect();
    state.watcher.unwatch_all(&dying);

    let mut removed_folders = 0usize;
    for path in &roots {
        if !library_locations::remove_location(&state.db, path).await? {
            continue;
        }
        removed_folders += 1;
    }

    // The same delete cascade the library's own Remove uses: progress,
    // collections, and annotations go with the row. Files on disk do not.
    // The cache scan runs once below, not once per row.
    let total = doomed.len();
    events.emit("unwatch-progress", &UnwatchProgress { removed: 0, total });
    let mut processed = 0usize;
    let mut last_reported = 0usize;
    let mut last_flush = Instant::now();
    for book_id in doomed {
        delete_book_and_notify(state, events, book_id).await?;
        processed += 1;
        if processed % EVENT_BATCH_BOOKS == 0
            || last_flush.elapsed().as_millis() >= EVENT_BATCH_WINDOW_MS
        {
            events.emit(
                "unwatch-progress",
                &UnwatchProgress {
                    removed: processed,
                    total,
                },
            );
            last_reported = processed;
            last_flush = Instant::now();
        }
    }

    // Sweep before the final count so a bar reading "all done" never sits
    // behind work still in flight.
    if processed > 0 {
        if let Err(err) = crate::services::artwork_cache::sweep_unreferenced_covers(
            &state.db,
            &covers_dir(&state.db_path),
        )
        .await
        {
            eprintln!("cover sweep after unwatch failed: {err}");
        }
    }
    if processed != last_reported {
        events.emit(
            "unwatch-progress",
            &UnwatchProgress {
                removed: processed,
                total,
            },
        );
    }
    Ok(removed_folders)
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
    emit_changed_book(events, book.clone());
    Ok(book)
}

/// Aggregate stats for the Application Data tab (data-management spec): each
/// watched location with its book count and total book bytes, the library's
/// total book bytes, and the catalog row counts.
pub async fn get_storage_stats(state: &AppState) -> Result<StorageStats, AppError> {
    storage::storage_stats(&state.db).await
}

/// Where a broken database was moved at startup, or `null` when the database
/// was healthy. Read-only: the sidecar records the quarantine once during
/// `init_state`, so this cannot trigger another.
pub async fn get_startup_recovery(state: &AppState) -> Result<Option<StartupRecovery>, AppError> {
    Ok(state.startup_recovery.clone())
}
