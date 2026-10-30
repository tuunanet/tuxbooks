//! Background content-hash backfill for existing books (ADR 0014 D8).
//!
//! Existing libraries predate hashing-at-import, so the upgrade marks each
//! file row `hash_state = 'pending'` and this job hashes them on the blocking
//! pool. A batch commits per book, so a restart simply picks up the rows that
//! are still pending. The status is read straight from the table: it is the
//! durable progress, not an in-memory counter.
//!
//! A failed hash is retried automatically: the row keeps a bounded backoff
//! clock (`hash_retry_at`) that the normal loop reads, so no separate scheduler
//! exists. An mtime change, a returning file, or a reconnected path resets the
//! clock to pending. A manual retry starts over with a clean attempt count.
//!
//! Hashing never blocks startup. New imports and reconnected files also land
//! as pending and are picked up by the same loop.

use std::time::Duration;

use sqlx::SqlitePool;

use crate::domain::IndexingRetry;
use crate::error::AppError;
use crate::repository::{books, identity_backfill, sync_issues};
use crate::sync::identity::ensure_book_identity;

/// How many books one batch claims before yielding. Small enough that a
/// shutdown or a new import does not wait on a whole library.
const BATCH: i64 = 16;

/// How long an idle pass waits before looking for new pending rows.
const IDLE_POLL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HashBackfillStatus {
    /// File rows whose bytes can be hashed right now.
    pub total: i64,
    pub hashed: i64,
    pub pending: i64,
    pub failed: i64,
    /// Rows whose file is unavailable; they stay pending until reconnected.
    pub waiting: i64,
}

/// Durable progress, read from `books.hash_state`.
pub async fn status(pool: &SqlitePool) -> Result<HashBackfillStatus, AppError> {
    let (total, hashed, pending, failed, waiting) = identity_backfill::hash_states(pool).await?;
    Ok(HashBackfillStatus {
        total,
        hashed,
        pending,
        failed,
        waiting,
    })
}

/// Hash one batch of pending or due-for-retry books. Returns how many attempts
/// were made (including failures), so the caller can decide whether to yield.
pub async fn process_batch(pool: &SqlitePool) -> Result<usize, AppError> {
    let ids = identity_backfill::pending_book_ids(pool, BATCH).await?;
    for id in &ids {
        process_book(pool, *id).await?;
    }
    Ok(ids.len())
}

/// Run batches until no hashable row is pending. Tests use this; production
/// uses [`start`], which also waits for new work.
pub async fn run_until_idle(pool: &SqlitePool) -> Result<usize, AppError> {
    let mut processed = 0;
    loop {
        let batch = process_batch(pool).await?;
        processed += batch;
        if batch == 0 {
            return Ok(processed);
        }
    }
}

async fn process_book(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    // A due failed row shows pending while the attempt runs. The retry clock is
    // left in place: a failure rewrites it, and a success clears it.
    identity_backfill::claim_for_retry(pool, book_id).await?;

    // The file can disappear between the batch query and here; leave it
    // pending so a reconnect or restart can still hash it.
    if identity_backfill::book_available(pool, book_id).await? != Some(true) {
        return Ok(());
    }

    match ensure_book_identity(pool, book_id).await {
        Ok(Some(_)) => resolve_hash_issue_if_clear(pool, book_id).await,
        Ok(None) => mark_failed(pool, book_id).await,
        Err(err) => {
            eprintln!("identity backfill: could not hash book {book_id}: {err}");
            mark_failed(pool, book_id).await
        }
    }
}

/// Retry indexing for one durable book (the public book id) and report its
/// state afterwards. Only available locations are retried: a missing copy is
/// not punished with a failed attempt, and the result says `missing` when no
/// location can be read. The reported state aggregates every location, so a
/// still-failed duplicate cannot read as `hashed`.
pub async fn retry_book(pool: &SqlitePool, book_id: i64) -> Result<IndexingRetry, AppError> {
    let file_ids = books::file_ids_for_book(pool, book_id).await?;
    if file_ids.is_empty() {
        return Err(AppError::NotFound);
    }
    let mut available = Vec::new();
    for file_id in file_ids {
        if identity_backfill::book_available(pool, file_id).await? == Some(true) {
            available.push(file_id);
        }
    }
    if available.is_empty() {
        return Ok(IndexingRetry {
            book_id,
            hash_state: IndexingRetry::MISSING.to_string(),
        });
    }
    for file_id in available {
        identity_backfill::reset_hash_for_retry(pool, file_id).await?;
        process_book(pool, file_id).await?;
    }
    let hash_state = identity_backfill::aggregate_hash_state(pool, book_id)
        .await?
        .unwrap_or_else(|| IndexingRetry::MISSING.to_string());
    Ok(IndexingRetry {
        book_id,
        hash_state,
    })
}

/// Finish the hash pass for the file rows a destructive action is about to
/// remove (ADR 0014 D8). A pending file is hashed now; a file that cannot be
/// read is marked failed instead of blocking the action. A row already failed
/// is not retried here: the automatic backoff owns that decision.
pub async fn wait_for_books(pool: &SqlitePool, file_ids: &[i64]) -> Result<(), AppError> {
    for file_id in file_ids {
        let row: Option<(String, bool)> =
            sqlx::query_as("SELECT hash_state, available FROM books WHERE id = ?1")
                .bind(file_id)
                .fetch_optional(pool)
                .await?;
        let Some((state, available)) = row else {
            continue;
        };
        if state != "pending" {
            continue;
        }
        if available {
            process_book(pool, *file_id).await?;
        } else {
            // There are no bytes to hash. Say so instead of silently leaving an
            // unknown hash behind a row that is about to disappear.
            mark_failed(pool, *file_id).await?;
        }
    }
    Ok(())
}

/// Record one failed attempt. The book keeps its record and becomes visible:
/// when sync is on it gets one open `hash_failed` sync issue with a Retry
/// action, and the book itself always carries a failed location.
pub async fn mark_failed(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    identity_backfill::mark_hash_failed(pool, book_id).await?;
    let Some((_, path)) = identity_backfill::book_reference(pool, book_id).await? else {
        return Ok(());
    };
    let Some(durable_id) = books::durable_id_for_file(pool, book_id).await? else {
        return Ok(());
    };
    record_hash_issue(pool, durable_id, &path).await
}

/// Make sure every book that is already failed has its sync issue. A status
/// refresh calls this so turning sync on surfaces failures that happened while
/// it was off. It only inserts missing rows, so repeated refreshes are quiet.
pub async fn ensure_failed_issues(pool: &SqlitePool) -> Result<(), AppError> {
    if !sync_issues::is_enabled(pool).await? {
        return Ok(());
    }
    for (durable_id, path) in identity_backfill::failed_book_paths(pool).await? {
        sync_issues::ensure(
            pool,
            &failure_key(durable_id),
            "hash_failed",
            &failure_detail(&path),
            None,
        )
        .await?;
    }
    Ok(())
}

async fn record_hash_issue(pool: &SqlitePool, durable_id: i64, path: &str) -> Result<(), AppError> {
    if !sync_issues::is_enabled(pool).await? {
        return Ok(());
    }
    sync_issues::record(
        pool,
        &failure_key(durable_id),
        "hash_failed",
        &failure_detail(path),
        None,
    )
    .await
}

/// Resolve the book's issue once no location is failed. One successful copy is
/// not enough when another copy is still unreadable.
/// Resolve the book's issue only when every location is hashed. A pending
/// location is mid-attempt or waiting for its file, and a failed one is still
/// broken, so both keep the row open.
async fn resolve_hash_issue_if_clear(pool: &SqlitePool, file_id: i64) -> Result<(), AppError> {
    let Some(durable_id) = books::durable_id_for_file(pool, file_id).await? else {
        return Ok(());
    };
    if identity_backfill::aggregate_hash_state(pool, durable_id)
        .await?
        .as_deref()
        != Some(IndexingRetry::HASHED)
    {
        return Ok(());
    }
    sync_issues::resolve(pool, &failure_key(durable_id)).await
}

fn failure_key(durable_id: i64) -> String {
    format!("hash-failed:{durable_id}")
}

fn failure_detail(path: &str) -> String {
    format!(
        "TuxBooks could not index \"{path}\". The book keeps its record; \
         Retry indexing now, or reconnect the file if it moved."
    )
}

/// Start the background pass. The first pass begins as soon as the runtime
/// schedules it, so opening a large library is never blocked on hashing.
pub fn start(pool: SqlitePool) {
    tokio::spawn(async move {
        loop {
            match process_batch(&pool).await {
                Ok(0) => tokio::time::sleep(IDLE_POLL).await,
                Ok(_) => tokio::task::yield_now().await,
                Err(err) => {
                    eprintln!("identity backfill paused: {err}");
                    tokio::time::sleep(IDLE_POLL).await;
                }
            }
        }
    });
}
