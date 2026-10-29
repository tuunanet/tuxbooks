use crate::domain::{Book, LibraryStats, SearchHit};
use crate::error::AppError;
use crate::repository::{books, collections};
use crate::rpc::EventEmitter;
use crate::services::library_reconciler::LibraryChange;
use crate::AppState;

/// Aggregate library counts for the frontend header/empty states.
pub async fn get_library_stats(state: &AppState) -> Result<LibraryStats, AppError> {
    let book_count = books::count_books(&state.db).await?;
    let collection_count = collections::count_collections(&state.db).await?;
    Ok(LibraryStats {
        book_count,
        collection_count,
    })
}

/// All books in the library, ordered by title.
pub async fn list_books(state: &AppState) -> Result<Vec<Book>, AppError> {
    books::list_books(&state.db).await
}

/// Reading history: durable books with no file rows, newest activity first.
/// `query` is optional user text; when present, the same FTS5 index and
/// sanitizer as library search apply with the opposite membership filter.
pub async fn list_reading_history(
    state: &AppState,
    query: Option<String>,
) -> Result<Vec<crate::domain::ReadingHistoryBook>, AppError> {
    crate::services::search::list_reading_history(&state.db, query.as_deref()).await
}

/// Durable progress of the background content-hash pass (ADR 0014 D8).
pub async fn identity_backfill_status(
    state: &AppState,
) -> Result<crate::services::hash_backfill::HashBackfillStatus, AppError> {
    crate::services::hash_backfill::status(&state.db).await
}

/// Open upgrade issues: identity merges and books that need a relink.
pub async fn migration_issues(
    state: &AppState,
) -> Result<Vec<crate::repository::migration::MigrationIssue>, AppError> {
    crate::repository::migration::list_open(&state.db).await
}

pub async fn dismiss_migration_issue(state: &AppState, id: i64) -> Result<bool, AppError> {
    crate::repository::migration::dismiss(&state.db, id).await
}

/// Full-text library search behind the global search box (Ctrl/Cmd+K).
/// Plain user text in; ranked hits with snippets out. Empty queries are
/// rejected — the frontend never sends them.
pub async fn search_books(state: &AppState, query: String) -> Result<Vec<SearchHit>, AppError> {
    crate::services::search::search_books(&state.db, &query).await
}

/// Remove a book from the library (user-initiated). The source file on disk
/// is never touched, and neither are the durable book, its reading progress,
/// or its annotations: only the file rows and therefore the membership go.
/// The client is told to drop the book via `library-changed`. Cover files the
/// removed row owned are artwork-cache garbage and are swept (best effort,
/// shared files survive the reference check).
pub async fn remove_book(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
) -> Result<bool, AppError> {
    let removed = delete_book_and_notify(state, events, book_id).await?;
    if removed {
        if let Err(err) = crate::services::artwork_cache::sweep_unreferenced_covers(
            &state.db,
            &crate::covers_dir(&state.db_path),
        )
        .await
        {
            eprintln!("cover sweep after removal failed: {err}");
        }
    }
    Ok(removed)
}

/// The row half of `remove_book`: settle the content hash for every file the
/// book still has, delete those file rows, and tell the client to drop the
/// book. The durable record and its state stay for a later re-import. A bulk
/// caller (unwatch) uses the per-file form and sweeps once at the end.
pub(crate) async fn delete_book_and_notify(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
) -> Result<bool, AppError> {
    let file_ids = books::file_ids_for_book(&state.db, book_id).await?;
    crate::services::hash_backfill::wait_for_books(&state.db, &file_ids).await?;
    // Waiting can hash a pending file and merge its identity into another
    // book. Re-resolve from a file row so the removal follows the book that
    // actually owns the bytes now.
    let book_id = match file_ids.first() {
        Some(file_id) => books::durable_id_for_file(&state.db, *file_id)
            .await?
            .unwrap_or(book_id),
        None => book_id,
    };
    let removed = books::delete_book(&state.db, book_id).await?;
    if removed {
        events.emit("library-changed", &LibraryChange::Removed { book_id });
    }
    Ok(removed)
}

/// Remove one file copy (an unwatch owns locations, not whole books). The
/// book leaves the library only when its last file row is gone; otherwise the
/// client gets the surviving active file.
pub(crate) async fn delete_file_row_and_notify(
    state: &AppState,
    events: &EventEmitter,
    file_id: i64,
    book_id: i64,
) -> Result<bool, AppError> {
    crate::services::hash_backfill::wait_for_books(&state.db, &[file_id]).await?;
    // The pending hash may have merged this file into another identity.
    let book_id = books::durable_id_for_file(&state.db, file_id)
        .await?
        .unwrap_or(book_id);
    if !books::delete_file_row(&state.db, file_id).await? {
        return Ok(false);
    }
    match books::get_book(&state.db, book_id).await? {
        Some(book) => crate::commands::emit_changed_book(events, book),
        None => events.emit("library-changed", &LibraryChange::Removed { book_id }),
    }
    Ok(true)
}
