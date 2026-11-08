use crate::domain::{
    Book, BookFile, BookTrashEntry, BulkForgetOutcome, EditionBook, EditionLinkOutcome,
    ForgetOutcome, IndexingRetry, LibraryStats, RestoreMode, RestoreOutcome, RestoreStatus,
    SearchHit,
};
use crate::error::AppError;
use crate::repository::{books, collections, editions, lifecycle};
use crate::rpc::EventEmitter;
use crate::services::library_reconciler::LibraryChange;
use crate::AppState;
use std::future::Future;
use std::time::Duration;

/// How hard one book fights transient write contention before a bulk run
/// gives up on it. A bulk run shares the database with the sync engine's
/// drain (one transaction per dirty row; WAL writers serialize), so a busy
/// write is a "try again in a moment", not a reason to abort a 1,000-book
/// run halfway (tuxbooks-nj2).
const BULK_BUSY_RETRIES: usize = 5;
const BULK_BUSY_BACKOFF_MS: u64 = 400;

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
    let mut all = books::list_books(&state.db).await?;
    // Decorated here rather than in the repository because the repository
    // module is over the push gate; the source of truth is the sync mirror
    // (ADR 0018 D3), so the decoration is one extra query per list.
    let unsettled: std::collections::HashSet<String> =
        crate::sync::file_version::unsettled_copies(&state.db)
            .await?
            .into_iter()
            .map(|copy| copy.book_uid)
            .collect();
    for book in &mut all {
        if let Some(uid) = &book.book_uid {
            book.newer_version_available = unsettled.contains(uid);
        }
    }
    Ok(all)
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

/// Retry the content-hash pass for one book now. The row is reset to pending
/// with a clean backoff and hashed immediately. Unavailable locations are
/// skipped, so a missing copy does not gain a failed attempt. The result
/// reports the aggregate state afterwards, so the client keeps the book warning
/// when a location is still unreadable. A fully hashed book clears the sync
/// issue for the old failure.
pub async fn retry_indexing(
    state: &AppState,
    events: &EventEmitter,
    book_id: i64,
) -> Result<IndexingRetry, AppError> {
    let outcome = crate::services::hash_backfill::retry_book(&state.db, book_id).await?;
    if let Some(book) = books::get_book(&state.db, book_id).await? {
        crate::commands::emit_changed_book(events, book);
    }
    // Hashing can merge this book into a shared identity and delete the row
    // the caller held, or delete another card that now shares its bytes.
    events.emit("library-changed", &LibraryChange::Reload);
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

/// SQLITE_BUSY (5) and SQLITE_LOCKED (6): another writer held the database.
/// sqlx's code() reports the EXTENDED code, so busy variants like
/// SQLITE_BUSY_SNAPSHOT (517) do not match the primary codes above; their
/// message is "database is locked", which the fallback catches. Each book's
/// destructive forget writes run in one transaction, so a busy failure there
/// rolled back cleanly and retrying that book is safe; the surrounding
/// snapshot reads are side-effect free and the pre-commit provider unlink is
/// idempotent.
fn is_transient_contention(err: &AppError) -> bool {
    let AppError::Database(sqlx::Error::Database(db)) = err else {
        return false;
    };
    if matches!(db.code().as_deref(), Some("5") | Some("6")) {
        return true;
    }
    let text = db.to_string().to_ascii_lowercase();
    text.contains("busy") || text.contains("locked")
}

/// Bulk Forget for Reading history. Each book gets the same atomic treatment
/// as the single command; the result counts what landed. Transient write
/// contention (the sync engine drains its queue in the same window) retries
/// with backoff instead of aborting the whole run.
pub async fn forget_books(
    state: &AppState,
    events: &EventEmitter,
    book_ids: Vec<i64>,
) -> Result<BulkForgetOutcome, AppError> {
    let mut forget = |book_id| forget_book_inner(state, book_id);
    bulk_forget_run(
        state,
        events,
        book_ids,
        &mut forget,
        BULK_BUSY_RETRIES,
        BULK_BUSY_BACKOFF_MS,
    )
    .await
}

/// The bulk run itself: per book, retry transient write contention with
/// backoff, count what landed, and abort on anything else. The per-book
/// forget is injected and the bounds are parameters so the retry branches
/// stay testable without a database or a minute-long lock (tuxbooks-ewu);
/// production passes the constants and the real inner forget.
pub(crate) async fn bulk_forget_run<F, Fut>(
    state: &AppState,
    events: &EventEmitter,
    book_ids: Vec<i64>,
    forget: &mut F,
    retries: usize,
    backoff_ms: u64,
) -> Result<BulkForgetOutcome, AppError>
where
    F: FnMut(i64) -> Fut,
    Fut: Future<Output = Result<ForgetOutcome, AppError>>,
{
    let mut trash_ids = Vec::new();
    let mut forgotten_count: i64 = 0;
    for book_id in book_ids {
        let mut outcome: Option<ForgetOutcome> = None;
        let mut saw_transient = false;
        for attempt in 0..=retries {
            match forget(book_id).await {
                Ok(forgotten) => {
                    outcome = Some(forgotten);
                    break;
                }
                Err(AppError::NotFound) => break,
                Err(err) if attempt < retries && is_transient_contention(&err) => {
                    saw_transient = true;
                    tokio::time::sleep(Duration::from_millis(backoff_ms * (attempt as u64 + 1)))
                        .await;
                }
                Err(err) => return Err(err),
            }
        }
        if let Some(outcome) = outcome {
            emit_forget(state, events, &outcome).await?;
            trash_ids.push(outcome.trash_id);
            forgotten_count += 1;
        } else if saw_transient {
            // The book was forgotten on an earlier attempt whose post-commit
            // bookkeeping lost a contention race: state is committed and the
            // view reloads the real lists afterwards, so skip the event and
            // the trash id rather than fail the run.
            forgotten_count += 1;
        }
    }
    Ok(BulkForgetOutcome {
        forgotten: forgotten_count,
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
    // The forgotten identity is deleted, so its card has to go even though a
    // book with a file keeps a fresh one in the same place (tuxbooks-jpj).
    events.emit(
        "library-changed",
        &LibraryChange::Removed {
            book_id: outcome.forgotten_book_id,
        },
    );
    if let Some(book_id) = outcome.replacement_book_id {
        if let Some(book) = books::get_book(&state.db, book_id).await? {
            crate::commands::emit_changed_book(events, book);
        }
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
    // A restore deletes records the renderer can still be showing: the fresh
    // identity, and the old one when it comes back under a new public id.
    // Announce those ids, or one file stays on the grid twice (tuxbooks-jpj).
    for book_id in &outcome.replaced_book_ids {
        events.emit(
            "library-changed",
            &LibraryChange::Removed { book_id: *book_id },
        );
    }
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

#[cfg(test)]
#[path = "books_tests.rs"]
mod tests;
