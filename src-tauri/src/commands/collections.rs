use tauri::State;

use crate::domain::CollectionSummary;
use crate::error::AppError;
use crate::repository::collections;
use crate::AppState;

/// Every collection with its member book ids. One call feeds the sidebar,
/// the collection library sections, and the book context menus.
#[tauri::command]
pub async fn list_collections(
    state: State<'_, AppState>,
) -> Result<Vec<CollectionSummary>, AppError> {
    collections::list_collection_summaries(&state.db).await
}

/// Create a named collection. Blank names are rejected; duplicate names fail
/// on the UNIQUE constraint (the UI surfaces the error inline).
#[tauri::command]
pub async fn create_collection(
    state: State<'_, AppState>,
    name: String,
) -> Result<CollectionSummary, AppError> {
    let id = collections::create_collection(&state.db, &name).await?;
    // Read the row back so the returned summary (including the DB-generated
    // created_at) is the stored truth.
    collections::get_collection_summary(&state.db, id)
        .await?
        .ok_or_else(|| AppError::InvalidInput("collection vanished after creation".into()))
}

/// Delete a collection. Books and their reading state are never touched;
/// only the grouping (and its membership rows) goes away.
#[tauri::command]
pub async fn delete_collection(
    state: State<'_, AppState>,
    collection_id: i64,
) -> Result<bool, AppError> {
    collections::delete_collection(&state.db, collection_id).await
}

/// Add a book to a collection (idempotent).
#[tauri::command]
pub async fn add_book_to_collection(
    state: State<'_, AppState>,
    book_id: i64,
    collection_id: i64,
) -> Result<(), AppError> {
    collections::add_book_to_collection(&state.db, book_id, collection_id).await
}

/// Remove a book from a collection; true when a membership row was deleted.
#[tauri::command]
pub async fn remove_book_from_collection(
    state: State<'_, AppState>,
    book_id: i64,
    collection_id: i64,
) -> Result<bool, AppError> {
    collections::remove_book_from_collection(&state.db, book_id, collection_id).await
}
