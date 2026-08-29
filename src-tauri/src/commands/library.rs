use std::path::PathBuf;

use tauri::State;

use crate::error::AppError;
use crate::services::book_importer::{import_directory, ImportReport};
use crate::{covers_dir, AppState};

/// Scan the directory at `path` for EPUB files and import them into the library.
#[tauri::command]
pub async fn scan_library(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportReport, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("library path is empty".into()));
    }
    let root = PathBuf::from(path);
    let covers = covers_dir(&state.db_path);
    import_directory(&state.db, &root, &covers).await
}
