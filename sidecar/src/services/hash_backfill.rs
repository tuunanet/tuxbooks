//! Background content-hash backfill for existing books (ADR 0014 D8).
//!
//! Existing libraries predate hashing-at-import, so the upgrade marks each
//! file row `hash_state = 'pending'` and this job hashes them on the blocking
//! pool. A batch commits per book, so a restart simply picks up the rows that
//! are still pending. The status is read straight from the table: it is the
//! durable progress, not an in-memory counter.
//!
//! Hashing never blocks startup. New imports and reconnected files also land
//! as pending and are picked up by the same loop.

use std::time::Duration;

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::repository::identity_backfill;
use crate::repository::migration;
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

/// Hash one batch of pending, available books. Returns how many attempts were
/// made (including failures), so the caller can decide whether to yield.
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
    // The file can disappear between the batch query and here; leave it
    // pending so a reconnect or restart can still hash it.
    if identity_backfill::book_available(pool, book_id).await? != Some(true) {
        return Ok(());
    }

    match ensure_book_identity(pool, book_id).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => mark_failed(pool, book_id).await,
        Err(err) => {
            eprintln!("identity backfill: could not hash book {book_id}: {err}");
            mark_failed(pool, book_id).await
        }
    }
}

/// Finish the hash pass for the file rows a destructive action is about to
/// remove (ADR 0014 D8). A pending file is hashed now; a file that cannot be
/// read is marked as needing a relink instead of blocking the action. Already
/// hashed rows are untouched.
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

/// A failed hash is a visible issue, not a stuck queue entry: the book keeps
/// its record and the destructive paths in the next slice may proceed.
async fn mark_failed(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    identity_backfill::mark_hash_failed(pool, book_id).await?;
    let Some((book_uid, path)) = identity_backfill::book_reference(pool, book_id).await? else {
        return Ok(());
    };
    migration::record_issue(
        pool,
        &format!("hash-failed:{book_id}"),
        "hash_failed",
        &format!(
            "TuxBooks could not hash \"{path}\". The book keeps its record; \
             reconnecting the file resets the hash, and the book needs a \
             relink if its bytes changed."
        ),
        book_uid.as_deref(),
    )
    .await
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
