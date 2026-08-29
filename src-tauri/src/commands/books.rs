use tauri::State;

use crate::domain::{Book, LibraryStats};
use crate::error::AppError;
use crate::repository::{books, collections};
use crate::AppState;

/// Aggregate library counts for the frontend header/empty states.
#[tauri::command]
pub async fn get_library_stats(state: State<'_, AppState>) -> Result<LibraryStats, AppError> {
    let book_count = books::count_books(&state.db).await?;
    let collection_count = collections::count_collections(&state.db).await?;
    Ok(LibraryStats {
        book_count,
        collection_count,
    })
}

/// All books in the library, ordered by title.
#[tauri::command]
pub async fn list_books(state: State<'_, AppState>) -> Result<Vec<Book>, AppError> {
    books::list_books(&state.db).await
}
