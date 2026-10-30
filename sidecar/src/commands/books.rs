use crate::domain::{
    Book, BookFile, BookTrashEntry, BulkForgetOutcome, EditionBook, EditionLinkOutcome,
    ForgetOutcome, LibraryStats, RestoreMode, RestoreOutcome, RestoreStatus, SearchHit,
};
use crate::error::AppError;
use crate::repository::{books, collections, editions, lifecycle};
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

/// Every file location of one durable book (ADR 0014 D7). The library still
/// shows one entry; the book details use this to list the duplicate copies.
pub async fn list_book_files(state: &AppState, book_id: i64) -> Result<Vec<BookFile>, AppError> {
    books::list_files_for_book(&state.db, book_id).await
}

/// Every edition linked to one durable book, newest activity first. Linking
/// never merges identities; a linked edition with no file is in Reading
/// history.
pub async fn list_book_editions(
    state: &AppState,
    book_id: i64,
) -> Result<Vec<EditionBook>, AppError> {
    editions::list_editions(&state.db, book_id).await
}

/// Confirm that two books are editions of one work (ADR 0014 D9). The books
/// stay separate identities. The source percentage is copied without a
/// locator, provider links and status move to the target, and annotations
/// stay with the source. A duplicate link or a provider conflict is rejected
/// before anything changes.
pub async fn link_book_edition(
    state: &AppState,
    events: &EventEmitter,
    source_book_id: i64,
    target_book_id: i64,
) -> Result<EditionLinkOutcome, AppError> {
    let outcome = editions::link_editions(&state.db, source_book_id, target_book_id).await?;
    // Both books changed: the target gained progress and provider links, the
    // source lost them. A book with no file row has no library event to emit;
    // Reading history reloads on the target's event.
    crate::commands::emit_book_changed(state, events, outcome.source_book_id).await?;
    crate::commands::emit_book_changed(state, events, outcome.target_book_id).await?;
    Ok(outcome)
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

/// Remove one file copy from the book details. The durable book, its reading
/// progress, annotations, collections, metadata, and last-opened stay; the
/// book leaves the library only when its last file row is gone.
pub async fn remove_book_file(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
    file_id: i64,
) -> Result<bool, AppError> {
    match books::durable_id_for_file(&state.db, file_id).await? {
        Some(owner) if owner == book_id => {}
        _ => return Err(AppError::NotFound),
    }
    delete_file_row_and_notify(state, events, file_id, book_id).await
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

/// Reset reading data (ADR 0014 D5): clear progress, annotations, collection
/// membership, metadata overrides, and provider links, but keep the durable
/// identity and the file row. The book stays in the library as unread.
pub async fn reset_book_reading_data(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
) -> Result<bool, AppError> {
    lifecycle::reset(&state.db, book_id).await?;
    match books::get_book(&state.db, book_id).await? {
        Some(book) => crate::commands::emit_changed_book(events, book),
        None => events.emit("library-changed", &LibraryChange::Removed { book_id }),
    }
    Ok(true)
}

/// Forget one book: rebind any current file to a fresh identity, move the old
/// record and state to the 30-day trash, and unlink providers. A book with no
/// file has no fresh identity and leaves Reading history.
pub async fn forget_book(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
) -> Result<ForgetOutcome, AppError> {
    let outcome = forget_book_inner(state, book_id).await?;
    emit_forget(state, events, &outcome).await?;
    Ok(outcome)
}

/// Bulk Forget for Reading history. Each book gets the same atomic treatment
/// as the single command; the result counts what landed.
pub async fn forget_books(
    state: &AppState,
    events: &EventEmitter,
    book_ids: Vec<i64>,
) -> Result<BulkForgetOutcome, AppError> {
    let mut trash_ids = Vec::new();
    for book_id in book_ids {
        match forget_book_inner(state, book_id).await {
            Ok(outcome) => {
                emit_forget(state, events, &outcome).await?;
                trash_ids.push(outcome.trash_id);
            }
            Err(AppError::NotFound) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(BulkForgetOutcome {
        forgotten: trash_ids.len() as i64,
        trash_ids,
    })
}

async fn forget_book_inner(state: &AppState, book_id: i64) -> Result<ForgetOutcome, AppError> {
    let file_ids = books::file_ids_for_book(&state.db, book_id).await?;
    crate::services::hash_backfill::wait_for_books(&state.db, &file_ids).await?;
    // A pending hash can merge this file into another identity. Follow the
    // bytes the user is looking at before taking a snapshot.
    let book_id = match file_ids.first() {
        Some(file_id) => books::durable_id_for_file(&state.db, *file_id)
            .await?
            .unwrap_or(book_id),
        None => book_id,
    };
    lifecycle::forget(&state.db, book_id).await
}

async fn emit_forget(
    state: &AppState,
    events: &EventEmitter,
    outcome: &ForgetOutcome,
) -> Result<(), AppError> {
    match outcome.replacement_book_id {
        Some(book_id) => {
            if let Some(book) = books::get_book(&state.db, book_id).await? {
                crate::commands::emit_changed_book(events, book);
                return Ok(());
            }
            events.emit(
                "library-changed",
                &LibraryChange::Removed {
                    book_id: outcome.forgotten_book_id,
                },
            );
        }
        None => events.emit(
            "library-changed",
            &LibraryChange::Removed {
                book_id: outcome.forgotten_book_id,
            },
        ),
    }
    Ok(())
}

/// Open forgotten books still inside the 30-day window.
pub async fn list_book_trash(state: &AppState) -> Result<Vec<BookTrashEntry>, AppError> {
    lifecycle::list_trash(&state.db).await
}

/// Restore a forgotten book. Without a mode the backend restores silently when
/// the fresh identity has no new progress or annotations and returns a
/// conflict otherwise; Replace, Keep, and Merge resolve it explicitly.
pub async fn restore_book(
    state: &AppState,
    events: &EventEmitter,
    trash_id: i64,
    mode: Option<RestoreMode>,
) -> Result<RestoreOutcome, AppError> {
    let outcome = lifecycle::restore(&state.db, trash_id, mode).await?;
    if let (RestoreStatus::Restored | RestoreStatus::Kept, Some(book_id)) =
        (&outcome.status, outcome.book_id)
    {
        if let Some(book) = books::get_book(&state.db, book_id).await? {
            crate::commands::emit_changed_book(events, book);
        } else {
            events.emit("library-changed", &LibraryChange::Removed { book_id });
        }
    }
    Ok(outcome)
}
