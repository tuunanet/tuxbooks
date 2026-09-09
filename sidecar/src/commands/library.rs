use std::path::PathBuf;

use crate::error::AppError;
use crate::repository::library_locations;
use crate::rpc::EventEmitter;
use crate::services::book_importer::{import_directory, import_file, ImportReport};
use crate::services::library_reconciler::{reconnect_book as reconnect, LibraryChange};
use crate::{covers_dir, pdfium_library_dirs, AppState};

/// Scan the directory at `path` for EPUB and PDF files and import them into
/// the library. Each persisted book is emitted as an `import-progress` event
/// so the UI can show books and covers as they arrive instead of after the
/// whole run.
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
    let report = import_directory(&state.db, &root, &covers, &pdfium_dirs, &|book| {
        events.emit("import-progress", book);
    })
    .await?;

    library_locations::add_location(&state.db, &root.to_string_lossy()).await?;
    state.watcher.watch(&root);
    Ok(report)
}

/// Import a mixed batch of files and/or folders (milestone 10). Folders are
/// scanned and registered as watched library locations exactly like
/// `scan_library`; plain files are imported in place and stay unwatched
/// (a stray single file does not turn its folder into a library root).
/// Each persisted book is emitted as `import-progress`; per-path failures
/// come back in the report so the UI can surface them honestly.
pub async fn import_paths(
    state: &AppState,
    events: &EventEmitter,
    paths: Vec<String>,
) -> Result<ImportReport, AppError> {
    let covers = covers_dir(&state.db_path);
    let pdfium_dirs = pdfium_library_dirs();
    let emit_progress = |book: &crate::domain::Book| {
        events.emit("import-progress", book);
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
