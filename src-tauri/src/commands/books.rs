use tauri::{Emitter, State};

use crate::domain::{Book, LibraryStats, SearchHit};
use crate::error::AppError;
use crate::repository::{books, collections};
use crate::services::library_reconciler::LibraryChange;
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

/// Full-text library search behind the global search box (Ctrl/Cmd+K).
/// Plain user text in; ranked hits with snippets out. Empty queries are
/// rejected — the frontend never sends them.
#[tauri::command]
pub async fn search_books(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchHit>, AppError> {
    crate::services::search::search_books(&state.db, &query).await
}

/// Remove a book from the library (user-initiated). The source file on disk
/// is never touched. Progress, collections, and the book row are deleted
/// together; the frontend is told to drop the book via `library-changed`.
/// Cover files the removed row owned are artwork-cache garbage and are
/// swept (best effort, shared files survive the reference check).
#[tauri::command]
pub async fn remove_book(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<bool, AppError> {
    let removed = books::delete_book(&state.db, book_id).await?;
    if removed {
        if let Err(err) = crate::services::artwork_cache::sweep_unreferenced_covers(
            &state.db,
            &crate::covers_dir(&state.db_path),
        )
        .await
        {
            eprintln!("cover sweep after removal failed: {err}");
        }
        let _ignored = app.emit("library-changed", LibraryChange::Removed { book_id });
    }
    Ok(removed)
}
