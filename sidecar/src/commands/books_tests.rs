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

/// Forget and restore each delete a public id the renderer can still be
/// showing: the forgotten identity, then the fresh one the restore
/// replaces. Both ride out as `removed`, so one file cannot stay on the
/// grid twice (tuxbooks-jpj).
#[tokio::test(flavor = "multi_thread")]
async fn forget_and_restore_announce_the_ids_that_died() {
    let tmp = tempfile::tempdir().unwrap();
    let state = test_state(tmp.path()).await;
    let (events, fired) = capturing_events();
    let (book_id, _) = seed_book(&state, "roundtrip.epub", "roundtrip").await;

    let forgotten = forget_book(&state, &events, book_id).await.unwrap();
    let fresh_id = forgotten
        .replacement_book_id
        .expect("a file-backed forget keeps a fresh identity");

    let restored = restore_book(&state, &events, forgotten.trash_id, None)
        .await
        .unwrap();
    assert_eq!(restored.status, RestoreStatus::Restored);
    assert_eq!(restored.book_id, Some(book_id), "the old id is back");
    assert!(
        !restored.replaced_book_ids.contains(&book_id),
        "an id that survived is not reported as replaced: {:?}",
        restored.replaced_book_ids
    );

    let mut removed: Vec<i64> = fired
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(name, payload)| {
            if *name != "library-changed" || payload["kind"].as_str() != Some("removed") {
                return None;
            }
            payload["bookId"].as_i64()
        })
        .collect();
    removed.sort_unstable();
    let mut expected = vec![book_id, fresh_id];
    expected.sort_unstable();
    assert_eq!(
        removed, expected,
        "each id that died is announced exactly once"
    );
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
                        let mut conn =
                            SqliteConnection::connect(&format!("sqlite://{}", db_path.display()))
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
    let open_trash_uids: Vec<String> =
        sqlx::query_scalar("SELECT book_uid FROM book_trash WHERE restored_at IS NULL ORDER BY id")
            .fetch_all(&state.db)
            .await
            .unwrap();
    assert_eq!(open_trash_uids, vec![b1_uid], "the prefix stayed forgotten");
    // No uid in the message: a failure message is a log write, and
    // CodeQL flags a uid reaching one (cleartext-logging). The flags are
    // in seed order, so the printed vector still says which survivor
    // lost its record.
    let mut kept = Vec::new();
    for uid in [b2_uid.as_str(), b3_uid.as_str()] {
        let survivors: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM book_records WHERE uid = ?1")
                .bind(uid)
                .fetch_optional(&state.db)
                .await
                .unwrap();
        kept.push(survivors.is_some());
    }
    assert_eq!(kept, vec![true, true], "both survivors keep their records");
    let durable: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(
        durable, 3,
        "the forgotten book's fresh record plus two survivors"
    );
}
