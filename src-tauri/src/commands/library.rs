use std::path::PathBuf;

use tauri::{Emitter, Manager, State};

use crate::error::AppError;
use crate::services::book_importer::{import_directory, ImportReport};
use crate::{covers_dir, pdfium_library_dirs, AppState};

/// Scan the directory at `path` for EPUB and PDF files and import them into
/// the library. Each persisted book is emitted as an `import-progress` event
/// so the UI can show books and covers as they arrive instead of after the
/// whole run.
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
    import_directory(&state.db, &root, &covers, &pdfium_dirs, &move |book| {
        let _ignored = emitter.emit("import-progress", book);
    })
    .await
}
