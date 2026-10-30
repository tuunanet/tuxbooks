//! Automatic retry of failed content hashes (ticket tuxbooks-c6g.6): the
//! bounded backoff, the manual retry, and the sync issue lifecycle.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tempfile::TempDir;

use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::{IndexingRetry, NewBook};
use tuxbooks_lib::repository::{books, identity_backfill, sync_issues};
use tuxbooks_lib::services::hash_backfill;

struct Env {
    _tmp: TempDir,
    pool: SqlitePool,
    dir: PathBuf,
}

impl Env {
    async fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("tuxbooks.db")).await.unwrap();
        let dir = tmp.path().join("library");
        std::fs::create_dir_all(&dir).unwrap();
        Self {
            _tmp: tmp,
            pool,
            dir,
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    async fn insert(&self, name: &str) -> i64 {
        let path = self.path(name);
        books::insert_book(&self.pool, &sample(&path, name))
            .await
            .unwrap()
    }

    async fn insert_location(&self, durable_id: i64, name: &str) {
        let path = self.path(name);
        books::insert_file_for_book(&self.pool, durable_id, &sample(&path, name))
            .await
            .unwrap();
    }

    async fn file_id(&self, name: &str) -> i64 {
        let path = self.path(name);
        books::find_file_id_by_path(&self.pool, &path.to_string_lossy())
            .await
            .unwrap()
            .expect("file row")
    }

    async fn failure(&self, file_id: i64) -> (String, i64, Option<String>) {
        sqlx::query_as("SELECT hash_state, hash_attempts, hash_retry_at FROM books WHERE id = ?1")
            .bind(file_id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// Only hash failures; a same-book duplicate row is a separate issue kind.
    async fn open_hash_issue_keys(&self) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT issue_key FROM sync_issues
             WHERE resolved_at IS NULL AND kind = 'hash_failed' ORDER BY issue_key",
        )
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }
}

fn sample(path: &Path, title: &str) -> NewBook {
    NewBook {
        path: path.to_string_lossy().into_owned(),
        title: title.into(),
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
        file_size: 0,
        file_mtime: 1_700_000_000,
    }
}

fn delay_secs(retry_at: &str) -> i64 {
    let at: DateTime<Utc> = retry_at.parse().unwrap();
    (at - Utc::now()).num_seconds()
}

#[tokio::test]
async fn a_failed_hash_waits_for_its_backoff_then_retries_automatically() {
    let env = Env::new().await;
    let durable = env.insert("book.epub").await;
    let file_id = env.file_id("book.epub").await;

    hash_backfill::run_until_idle(&env.pool).await.unwrap();
    let (state, attempts, retry_at) = env.failure(file_id).await;
    assert_eq!(state, "failed");
    assert_eq!(attempts, 1);
    let first = retry_at.expect("the first failure schedules the retry");
    assert!(
        (55..=60).contains(&delay_secs(&first)),
        "the first retry waits about a minute, got {}s",
        delay_secs(&first)
    );

    // The retry clock is in the future, so the normal loop leaves it alone.
    let pending = identity_backfill::pending_book_ids(&env.pool, 10)
        .await
        .unwrap();
    assert!(
        !pending.contains(&file_id),
        "a row inside its backoff window is not retried yet"
    );

    // Once the delay passes, the same query picks the row up. A second failure
    // counts the attempt and moves the clock to the next schedule step.
    sqlx::query("UPDATE books SET hash_retry_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1")
        .bind(file_id)
        .execute(&env.pool)
        .await
        .unwrap();
    let pending = identity_backfill::pending_book_ids(&env.pool, 10)
        .await
        .unwrap();
    assert_eq!(pending, vec![file_id], "a due failure is retried");
    hash_backfill::run_until_idle(&env.pool).await.unwrap();
    let (state, attempts, later_retry) = env.failure(file_id).await;
    assert_eq!(state, "failed");
    assert_eq!(attempts, 2, "the automatic retry counts its failure");
    let second = later_retry.expect("the second failure reschedules the retry");
    assert!(
        (295..=300).contains(&delay_secs(&second)),
        "the second retry waits about five minutes, got {}s",
        delay_secs(&second)
    );

    // The file becomes readable and the next due pass hashes it.
    sqlx::query("UPDATE books SET hash_retry_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1")
        .bind(file_id)
        .execute(&env.pool)
        .await
        .unwrap();
    std::fs::write(env.path("book.epub"), b"now the file can be read").unwrap();
    hash_backfill::run_until_idle(&env.pool).await.unwrap();
    let (state, attempts, retry_at) = env.failure(file_id).await;
    assert_eq!(state, "hashed");
    assert_eq!(attempts, 0, "success clears the retry budget");
    assert_eq!(retry_at, None);

    let book = books::get_book(&env.pool, durable).await.unwrap().unwrap();
    assert_eq!(book.hash_state, "hashed");
}

#[tokio::test]
async fn a_due_retry_shows_pending_before_the_attempt_finishes() {
    let env = Env::new().await;
    env.insert("book.epub").await;
    let file_id = env.file_id("book.epub").await;
    hash_backfill::run_until_idle(&env.pool).await.unwrap();
    let (_, attempts, retry_at) = env.failure(file_id).await;
    assert_eq!(attempts, 1);

    identity_backfill::claim_for_retry(&env.pool, file_id)
        .await
        .unwrap();
    let (state, claimed_attempts, claimed_retry) = env.failure(file_id).await;
    assert_eq!(state, "pending", "the book shows pending while it retries");
    assert_eq!(
        claimed_attempts, attempts,
        "claiming does not count an attempt"
    );
    assert_eq!(
        claimed_retry, retry_at,
        "the old clock stays until a failure writes a new one"
    );
}

#[tokio::test]
async fn a_manual_retry_that_still_fails_counts_the_attempt_and_waits() {
    let env = Env::new().await;
    let durable = env.insert("book.epub").await;
    let file_id = env.file_id("book.epub").await;
    hash_backfill::run_until_idle(&env.pool).await.unwrap();

    let outcome = hash_backfill::retry_book(&env.pool, durable).await.unwrap();
    assert_eq!(outcome.book_id, durable);
    assert_eq!(outcome.hash_state, IndexingRetry::FAILED);
    let (state, attempts, retry_at) = env.failure(file_id).await;
    assert_eq!(state, "failed");
    assert_eq!(
        attempts, 1,
        "a manual retry starts the budget over before this attempt"
    );
    let delay = delay_secs(&retry_at.expect("the failed retry schedules another attempt"));
    assert!((55..=60).contains(&delay), "the retry waits about a minute");
}

#[tokio::test]
async fn a_successful_retry_hashes_available_locations_and_reports_the_aggregate() {
    let env = Env::new().await;
    let durable = env.insert("book.epub").await;
    env.insert_location(durable, "copy.epub").await;
    let file_id = env.file_id("book.epub").await;
    hash_backfill::run_until_idle(&env.pool).await.unwrap();
    let copy_id = env.file_id("copy.epub").await;
    assert_eq!(env.failure(copy_id).await.0, "failed");

    // The second location is known to be away, so a manual retry leaves it
    // alone and its attempt budget untouched.
    sqlx::query("UPDATE books SET available = 0, hash_attempts = 3 WHERE id = ?1")
        .bind(copy_id)
        .execute(&env.pool)
        .await
        .unwrap();
    std::fs::write(env.path("book.epub"), b"the file came back").unwrap();
    let outcome = hash_backfill::retry_book(&env.pool, durable).await.unwrap();
    assert_eq!(outcome.hash_state, IndexingRetry::FAILED);
    let (state, attempts, retry_at) = env.failure(file_id).await;
    assert_eq!(state, "hashed");
    assert_eq!(attempts, 0);
    assert_eq!(retry_at, None);
    let (state, attempts, _) = env.failure(copy_id).await;
    assert_eq!(state, "failed", "an unavailable location is not retried");
    assert_eq!(
        attempts, 3,
        "an unavailable location keeps its attempt count"
    );
    assert_eq!(
        books::get_book(&env.pool, durable)
            .await
            .unwrap()
            .unwrap()
            .hash_state,
        "failed",
        "a failed duplicate outranks the hashed active copy"
    );

    // Once the second copy is back, the retry hashes it too.
    std::fs::write(env.path("copy.epub"), b"the second copy came back").unwrap();
    sqlx::query("UPDATE books SET available = 1 WHERE id = ?1")
        .bind(copy_id)
        .execute(&env.pool)
        .await
        .unwrap();
    let outcome = hash_backfill::retry_book(&env.pool, durable).await.unwrap();
    assert_eq!(outcome.hash_state, IndexingRetry::HASHED);
    assert_eq!(
        books::get_book(&env.pool, durable)
            .await
            .unwrap()
            .unwrap()
            .hash_state,
        "hashed"
    );
    let keys = env.open_hash_issue_keys().await;
    assert_eq!(keys.len(), 0, "sync is off here: {keys:?}");
}

#[tokio::test]
async fn retry_reports_missing_when_no_location_is_available() {
    let env = Env::new().await;
    let durable = env.insert("gone.epub").await;
    env.insert_location(durable, "also-gone.epub").await;
    let first = env.file_id("gone.epub").await;
    let second = env.file_id("also-gone.epub").await;
    hash_backfill::run_until_idle(&env.pool).await.unwrap();
    assert_eq!(env.failure(first).await.1, 1);
    assert_eq!(env.failure(second).await.1, 1);

    // Mark both unavailable: a retry must not count another failed attempt.
    sqlx::query("UPDATE books SET available = 0 WHERE id IN (?1, ?2)")
        .bind(first)
        .bind(second)
        .execute(&env.pool)
        .await
        .unwrap();
    let outcome = hash_backfill::retry_book(&env.pool, durable).await.unwrap();
    assert_eq!(outcome.hash_state, IndexingRetry::MISSING);
    assert_eq!(env.failure(first).await.1, 1);
    assert_eq!(env.failure(second).await.1, 1);
}

#[tokio::test]
async fn a_file_snapshot_change_resets_the_backoff_to_pending() {
    let env = Env::new().await;
    env.insert("book.epub").await;
    let file_id = env.file_id("book.epub").await;
    hash_backfill::run_until_idle(&env.pool).await.unwrap();
    assert_eq!(env.failure(file_id).await.0, "failed");

    books::update_file_snapshot(&env.pool, file_id, 42, 1_800_000_000)
        .await
        .unwrap();
    let (state, attempts, retry_at) = env.failure(file_id).await;
    assert_eq!(state, "pending");
    assert_eq!(attempts, 0);
    assert_eq!(retry_at, None);

    // A relink does the same: the new location gets a fresh retry budget.
    sqlx::query("UPDATE books SET hash_state = 'failed', hash_attempts = 4 WHERE id = ?1")
        .bind(file_id)
        .execute(&env.pool)
        .await
        .unwrap();
    books::relink_book(
        &env.pool,
        file_id,
        &env.path("book.epub").to_string_lossy(),
        7,
        9,
    )
    .await
    .unwrap();
    let (state, attempts, retry_at) = env.failure(file_id).await;
    assert_eq!(state, "pending");
    assert_eq!(attempts, 0);
    assert_eq!(retry_at, None);

    // A changed size/mtime on re-import does the same.
    let mut updated = sample(&env.path("book.epub"), "Book");
    updated.file_size = 99;
    updated.file_mtime += 60;
    books::update_book_by_path(&env.pool, &updated)
        .await
        .unwrap();
    sqlx::query("UPDATE books SET hash_state = 'failed', hash_attempts = 2 WHERE id = ?1")
        .bind(file_id)
        .execute(&env.pool)
        .await
        .unwrap();
    updated.file_size = 1;
    updated.file_mtime += 60;
    books::update_book_by_path(&env.pool, &updated)
        .await
        .unwrap();
    let (state, attempts, retry_at) = env.failure(file_id).await;
    assert_eq!(state, "pending");
    assert_eq!(attempts, 0);
    assert_eq!(retry_at, None);
}

#[tokio::test]
async fn a_returning_file_resets_the_backoff_even_with_the_same_snapshot() {
    let env = Env::new().await;
    env.insert("book.epub").await;
    let file_id = env.file_id("book.epub").await;
    hash_backfill::run_until_idle(&env.pool).await.unwrap();
    assert_eq!(env.failure(file_id).await.0, "failed");

    sqlx::query("UPDATE books SET available = 0 WHERE id = ?1")
        .bind(file_id)
        .execute(&env.pool)
        .await
        .unwrap();
    // Same size and mtime: only the returning availability can reset the row.
    books::update_book_by_path(&env.pool, &sample(&env.path("book.epub"), "Book"))
        .await
        .unwrap();
    let (state, attempts, retry_at) = env.failure(file_id).await;
    assert_eq!(state, "pending");
    assert_eq!(attempts, 0);
    assert_eq!(retry_at, None);
}

#[tokio::test]
async fn ensuring_an_issue_refreshes_changed_detail_without_touching_an_unchanged_row() {
    let env = Env::new().await;
    let key = "hash-failed:1";
    sync_issues::ensure(
        &env.pool,
        key,
        "hash_failed",
        "could not index the old path",
        None,
    )
    .await
    .unwrap();
    sqlx::query(
        "UPDATE sync_issues SET updated_at = '2000-01-01T00:00:00.000Z' WHERE issue_key = ?1",
    )
    .bind(key)
    .execute(&env.pool)
    .await
    .unwrap();

    // Re-asserting the same detail leaves the row untouched, so a status poll
    // cannot make a stable issue look fresh.
    sync_issues::ensure(
        &env.pool,
        key,
        "hash_failed",
        "could not index the old path",
        None,
    )
    .await
    .unwrap();
    let (detail, updated_at): (String, String) =
        sqlx::query_as("SELECT detail, updated_at FROM sync_issues WHERE issue_key = ?1")
            .bind(key)
            .fetch_one(&env.pool)
            .await
            .unwrap();
    assert_eq!(detail, "could not index the old path");
    assert_eq!(
        updated_at, "2000-01-01T00:00:00.000Z",
        "an unchanged sweep does not bump updated_at"
    );

    // A different failing location updates the detail and the file name.
    sync_issues::ensure(
        &env.pool,
        key,
        "hash_failed",
        "could not index the new path",
        Some("ops/new.json"),
    )
    .await
    .unwrap();
    let (detail, file_name, updated_at): (String, Option<String>, String) = sqlx::query_as(
        "SELECT detail, file_name, updated_at FROM sync_issues WHERE issue_key = ?1",
    )
    .bind(key)
    .fetch_one(&env.pool)
    .await
    .unwrap();
    assert_eq!(detail, "could not index the new path");
    assert_eq!(file_name.as_deref(), Some("ops/new.json"));
    assert_ne!(
        updated_at, "2000-01-01T00:00:00.000Z",
        "a changed row is bumped"
    );
}

#[tokio::test]
async fn hash_failures_become_one_issue_per_durable_book_only_when_sync_is_on() {
    let env = Env::new().await;
    let durable = env.insert("book.epub").await;
    env.insert_location(durable, "copy.epub").await;
    hash_backfill::run_until_idle(&env.pool).await.unwrap();

    assert!(
        env.open_hash_issue_keys().await.is_empty(),
        "sync is off, so the book warning is the only surface"
    );

    assert!(!sync_issues::is_enabled(&env.pool).await.unwrap());
    sqlx::query("INSERT INTO sync_meta (key, value) VALUES ('enabled', '1')")
        .execute(&env.pool)
        .await
        .unwrap();
    hash_backfill::ensure_failed_issues(&env.pool)
        .await
        .unwrap();
    assert_eq!(
        env.open_hash_issue_keys().await,
        vec![format!("hash-failed:{durable}")],
        "two failed locations share one durable-book issue"
    );
    // The sweep is idempotent: a second refresh does not duplicate the row.
    hash_backfill::ensure_failed_issues(&env.pool)
        .await
        .unwrap();
    assert_eq!(env.open_hash_issue_keys().await.len(), 1);

    // A successful hash of both locations resolves the issue it created.
    std::fs::write(env.path("book.epub"), b"readable again").unwrap();
    std::fs::write(env.path("copy.epub"), b"readable copy again").unwrap();
    let outcome = hash_backfill::retry_book(&env.pool, durable).await.unwrap();
    assert_eq!(outcome.hash_state, IndexingRetry::HASHED);
    assert!(
        env.open_hash_issue_keys().await.is_empty(),
        "a successful hash resolves the issue"
    );
}
