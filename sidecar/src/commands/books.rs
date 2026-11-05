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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::init_pool;
    use crate::domain::NewBook;
    use crate::sync::identity::ensure_book_identity;
    use serde_json::Value;
    use sqlx::error::{DatabaseError, ErrorKind};
    use sqlx::{Connection, SqliteConnection};
    use std::borrow::Cow;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    type FiredEvents = Vec<(&'static str, Value)>;

    /// EventEmitter paired with everything it fired, so a test can assert
    /// what the run pushed to the client.
    fn capturing_events() -> (EventEmitter, Arc<Mutex<FiredEvents>>) {
        let fired: Arc<Mutex<FiredEvents>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&fired);
        let events = EventEmitter::new(move |name, payload| {
            sink.lock().unwrap().push((name, payload));
        });
        (events, fired)
    }

    async fn test_state(dir: &std::path::Path) -> Arc<AppState> {
        let pool = init_pool(&dir.join("t.db")).await.unwrap();
        let reconciler = Arc::new(crate::services::library_reconciler::Reconciler::new(
            pool.clone(),
            dir.join("covers"),
            Vec::new(),
            tokio::runtime::Handle::current(),
            Box::new(|_| {}),
        ));
        let watcher = crate::services::library_watcher::LibraryWatcher::start(
            crate::services::library_watcher::WatcherConfig {
                reconciler,
                debounce: std::time::Duration::from_millis(50),
            },
        )
        .unwrap();
        Arc::new(AppState {
            db: pool,
            db_path: dir.join("t.db"),
            watcher: Arc::new(watcher),
            startup_recovery: None,
            sync: None,
            importing: Default::default(),
        })
    }

    /// Seed one durable file-backed book the way the import pipeline lands
    /// one: distinct bytes, one identity each.
    async fn seed_book(state: &AppState, name: &str, tag: &str) -> (i64, String) {
        let library = state.db_path.parent().unwrap().join("library");
        std::fs::create_dir_all(&library).unwrap();
        let path = library.join(name);
        std::fs::write(&path, format!("durable bytes for {tag}\n")).unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        let mtime = metadata
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let upserted = books::upsert_file(
            &state.db,
            &NewBook {
                path: path.to_string_lossy().into_owned(),
                title: name.trim_end_matches(".epub").to_string(),
                subtitle: None,
                author: Some("Author".into()),
                authors: vec!["Author".into()],
                subjects: Vec::new(),
                publisher: None,
                language: None,
                isbn: None,
                description: None,
                publication_date: None,
                series: None,
                series_index: None,
                cover_path: None,
                file_size: metadata.len() as i64,
                file_mtime: mtime,
            },
        )
        .await
        .unwrap();
        ensure_book_identity(&state.db, upserted.file_id)
            .await
            .unwrap();
        let id = books::durable_id_for_file(&state.db, upserted.file_id)
            .await
            .unwrap()
            .expect("seeded book is durable");
        let uid: String = sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
            .bind(id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        (id, uid)
    }

    /// SQLITE_BUSY-shaped error for driving the retry branches without a
    /// database. The code and the message both match
    /// `is_transient_contention`.
    #[derive(Debug)]
    struct FakeBusy;

    impl std::fmt::Display for FakeBusy {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "database is locked")
        }
    }

    impl std::error::Error for FakeBusy {}

    impl DatabaseError for FakeBusy {
        fn message(&self) -> &str {
            "database is locked"
        }

        fn code(&self) -> Option<Cow<'_, str>> {
            Some(Cow::Borrowed("5"))
        }

        fn kind(&self) -> ErrorKind {
            ErrorKind::Other
        }

        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }

        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }

        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }
    }

    fn busy_error() -> AppError {
        AppError::Database(sqlx::Error::Database(Box::new(FakeBusy)))
    }

    /// Contention that outlasts the whole budget surfaces the error after
    /// the bounded attempts instead of hanging, and the run stops there:
    /// books after the failure are never attempted (tuxbooks-ewu).
    #[tokio::test(flavor = "multi_thread")]
    async fn exhaustion_surfaces_the_error_in_bounded_time_and_stops_the_run() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let (events, _fired) = capturing_events();

        let attempted: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(Vec::new()));
        let mut forget = {
            let attempted = Arc::clone(&attempted);
            move |book_id| {
                let attempted = Arc::clone(&attempted);
                async move {
                    attempted.lock().unwrap().push(book_id);
                    Err::<ForgetOutcome, AppError>(busy_error())
                }
            }
        };

        let started = Instant::now();
        let result = bulk_forget_run(&state, &events, vec![1, 2], &mut forget, 2, 1).await;
        let elapsed = started.elapsed();

        let err = result.unwrap_err();
        assert!(
            is_transient_contention(&err),
            "the surfaced error is the contention: {err}"
        );
        assert_eq!(
            attempted.lock().unwrap().as_slice(),
            [1, 1, 1],
            "the failing book used its whole budget, the next book was never tried"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "bounded, not a hang: {elapsed:?}"
        );
    }

    /// The saw_transient branch: a book whose forget committed on an
    /// earlier attempt but whose post-commit bookkeeping lost the race
    /// surfaces as NotFound on the retry. The run counts it without a
    /// trash id and without an event, and keeps going (tuxbooks-ewu).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_transient_then_missing_book_counts_without_a_trash_id() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let (events, fired) = capturing_events();

        let calls = Arc::new(AtomicUsize::new(0));
        let mut forget = {
            let calls = Arc::clone(&calls);
            move |book_id| {
                let calls = Arc::clone(&calls);
                async move {
                    let call = calls.fetch_add(1, Ordering::SeqCst);
                    let _ = book_id;
                    if call == 0 {
                        Err::<ForgetOutcome, AppError>(busy_error())
                    } else {
                        Err(AppError::NotFound)
                    }
                }
            }
        };

        let outcome = bulk_forget_run(&state, &events, vec![7], &mut forget, 5, 1)
            .await
            .unwrap();
        assert_eq!(outcome.forgotten, 1, "the committed forget still counts");
        assert!(
            outcome.trash_ids.is_empty(),
            "no trash id: the bookkeeping lost its race"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2, "one retry, then NotFound");
        assert!(
            fired.lock().unwrap().is_empty(),
            "the event is skipped with the trash id"
        );
    }

    /// A book that is simply gone, with no transient before it, is skipped
    /// without being counted: the NotFound break keeps saw_transient false.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_missing_book_without_contention_is_not_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let (events, fired) = capturing_events();

        let calls = Arc::new(AtomicUsize::new(0));
        let mut forget = {
            let calls = Arc::clone(&calls);
            move |book_id| {
                let calls = Arc::clone(&calls);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    let _ = book_id;
                    Err::<ForgetOutcome, AppError>(AppError::NotFound)
                }
            }
        };

        let outcome = bulk_forget_run(&state, &events, vec![7], &mut forget, 5, 1)
            .await
            .unwrap();
        assert_eq!(outcome.forgotten, 0);
        assert!(outcome.trash_ids.is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 1, "no retry on NotFound");
        assert!(fired.lock().unwrap().is_empty());
    }

    /// The bounded-failure path against a real database: contention that
    /// outlasts the budget surfaces the error (never a hang), the books the
    /// run already forgot stay forgotten as a reloadable prefix, and the
    /// survivors keep their records untouched (tuxbooks-nj2,
    /// tuxbooks-ewu).
    #[tokio::test(flavor = "multi_thread")]
    async fn exhaustion_with_a_real_database_keeps_the_forgotten_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let state = test_state(tmp.path()).await;
        let (events, _fired) = capturing_events();
        let (b1, b1_uid) = seed_book(&state, "first.epub", "one").await;
        let (b2, b2_uid) = seed_book(&state, "second.epub", "two").await;
        let (b3, b3_uid) = seed_book(&state, "third.epub", "three").await;

        // Before the second book's forget starts, hold the write lock, so
        // its single attempt (retries = 0) fails busy against the held
        // lock and aborts the run. The ready channel hands the lock over
        // deterministically, without racing the forgets.
        let calls = Arc::new(AtomicUsize::new(0));
        let mut forget = {
            let calls = Arc::clone(&calls);
            let state = Arc::clone(&state);
            let db_path = state.db_path.clone();
            move |book_id| {
                let calls = Arc::clone(&calls);
                let state = Arc::clone(&state);
                let db_path = db_path.clone();
                async move {
                    let call = calls.fetch_add(1, Ordering::SeqCst);
                    if call == 1 {
                        let (lock_ready, lock_ready_rx) = tokio::sync::oneshot::channel();
                        tokio::spawn(async move {
                            let mut conn = SqliteConnection::connect(&format!(
                                "sqlite://{}",
                                db_path.display()
                            ))
                            .await
                            .unwrap();
                            sqlx::query("BEGIN IMMEDIATE")
                                .execute(&mut conn)
                                .await
                                .unwrap();
                            let _ = lock_ready.send(());
                            tokio::time::sleep(Duration::from_secs(8)).await;
                            let _ = sqlx::query("COMMIT").execute(&mut conn).await;
                        });
                        let _ = lock_ready_rx.await;
                    }
                    forget_book_inner(&state, book_id).await
                }
            }
        };

        let started = Instant::now();
        let result = bulk_forget_run(&state, &events, vec![b1, b2, b3], &mut forget, 0, 1).await;
        let elapsed = started.elapsed();

        let err = result.unwrap_err();
        assert!(
            is_transient_contention(&err),
            "contention surfaces as the transient error: {err}"
        );
        // SQLite returns busy immediately when a deferred transaction
        // upgrades to a write lock another writer holds, so the bound here
        // is generous for CI load, not for lock waits. The waiting the run
        // does to survive contention lives in the backoff, which the
        // surviving-contention tests cover.
        assert!(
            elapsed < Duration::from_secs(30),
            "bounded, not a hang: {elapsed:?}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "the run stops at the failing book"
        );

        // What landed before the failure stays forgotten and reloadable;
        // the survivors are untouched.
        let open_trash_uids: Vec<String> = sqlx::query_scalar(
            "SELECT book_uid FROM book_trash WHERE restored_at IS NULL ORDER BY id",
        )
        .fetch_all(&state.db)
        .await
        .unwrap();
        assert_eq!(open_trash_uids, vec![b1_uid], "the prefix stayed forgotten");
        for uid in [b2_uid.as_str(), b3_uid.as_str()] {
            let survivors: Option<(i64,)> =
                sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
                    .bind(uid)
                    .fetch_optional(&state.db)
                    .await
                    .unwrap();
            assert!(survivors.is_some(), "{uid} keeps its record");
        }
        let durable: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(
            durable, 3,
            "the forgotten book's fresh record plus two survivors"
        );
    }
}
