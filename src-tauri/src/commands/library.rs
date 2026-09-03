use std::path::PathBuf;

use tauri::{Emitter, Manager, State};

use crate::error::AppError;
use crate::repository::library_locations;
use crate::services::book_importer::{import_directory, ImportReport};
use crate::services::library_reconciler::{reconnect_book as reconnect, LibraryChange};
use crate::{covers_dir, pdfium_library_dirs, AppState};

/// Scan the directory at `path` for EPUB and PDF files and import them into
/// the library. Each persisted book is emitted as an `import-progress` event
/// so the UI can show books and covers as they arrive instead of after the
/// whole run.
///
/// The directory is also registered as a watched library location, so after
/// this scan the filesystem watcher keeps it synchronized (milestone 3).
#[tauri::command]
pub async fn scan_library(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportReport, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("library path is empty".into()));
    }
    let root = PathBuf::from(path);
    let covers = covers_dir(&state.db_path);
    let pdfium_dirs = pdfium_library_dirs(app.path().resource_dir().ok());
    let emitter = app.clone();
    let report = import_directory(&state.db, &root, &covers, &pdfium_dirs, &move |book| {
        let _ignored = emitter.emit("import-progress", book);
    })
    .await?;

    library_locations::add_location(&state.db, &root.to_string_lossy()).await?;
    state.watcher.watch(&root);
    Ok(report)
}

/// Reconnect an unavailable book to a new file chosen by the user. The book
/// keeps its id — and therefore metadata, collections, and reading progress —
/// while path and parsed metadata are refreshed from the located file.
#[tauri::command]
pub async fn reconnect_book(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    book_id: i64,
    path: String,
) -> Result<crate::domain::Book, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("book path is empty".into()));
    }
    let covers = covers_dir(&state.db_path);
    let pdfium_dirs = pdfium_library_dirs(app.path().resource_dir().ok());
    let book = reconnect(
        &state.db,
        book_id,
        std::path::Path::new(&path),
        &covers,
        &pdfium_dirs,
    )
    .await?;
    let _ignored = app.emit(
        "library-changed",
        LibraryChange::Changed {
            book: Box::new(book.clone()),
        },
    );
    Ok(book)
}
