//! Queries for the background content-hash pass. The orchestration lives in
//! `services::hash_backfill`; SQL stays here.

use sqlx::SqlitePool;

use crate::error::AppError;

/// Bounded retry schedule, in seconds, keyed by the attempt that just failed.
/// The delay keeps growing but stops at the last entry; the attempt count
/// itself is not capped, because it only documents how often the file was
/// unreadable.
const RETRY_DELAYS_SECS: [i64; 6] = [60, 300, 900, 3600, 21_600, 86_400];
const RETRY_DELAY_CAP_SECS: i64 = RETRY_DELAYS_SECS[RETRY_DELAYS_SECS.len() - 1];

/// Delay before the next automatic attempt after `attempts` failures.
pub fn retry_delay_secs(attempts: i64) -> i64 {
    let index = attempts.max(1) as usize - 1;
    RETRY_DELAYS_SECS
        .get(index)
        .copied()
        .unwrap_or(RETRY_DELAY_CAP_SECS)
}

fn retry_at_after(attempts: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::seconds(retry_delay_secs(attempts)))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `(total, hashed, pending, failed, waiting)` for available files, plus the
/// rows whose file is currently unavailable.
pub async fn hash_states(pool: &SqlitePool) -> Result<(i64, i64, i64, i64, i64), AppError> {
    let counts = sqlx::query_as(
        r#"
        SELECT
            COUNT(*) FILTER (WHERE available = 1),
            COUNT(*) FILTER (WHERE available = 1 AND hash_state = 'hashed'),
            COUNT(*) FILTER (WHERE available = 1 AND hash_state = 'pending'),
            COUNT(*) FILTER (WHERE available = 1 AND hash_state = 'failed'),
            COUNT(*) FILTER (WHERE available = 0 AND hash_state = 'pending')
        FROM books
        "#,
    )
    .fetch_one(pool)
    .await?;
    Ok(counts)
}

/// Book ids whose bytes still need hashing, oldest row first. A failed row is
/// picked up again once its retry clock is due (or was never set), so the
/// backoff needs no scheduler of its own: the normal loop is the scheduler.
pub async fn pending_book_ids(pool: &SqlitePool, limit: i64) -> Result<Vec<i64>, AppError> {
    let ids = sqlx::query_scalar(
        "SELECT id FROM books
         WHERE available = 1
           AND (
               hash_state = 'pending'
               OR (
                   hash_state = 'failed'
                   AND (hash_retry_at IS NULL
                        OR hash_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
               )
           )
         ORDER BY id
         LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(ids)
}

/// Whether the file is still expected on disk, re-read right before hashing so
/// a file that vanished after the batch query stays pending.
pub async fn book_available(pool: &SqlitePool, book_id: i64) -> Result<Option<bool>, AppError> {
    let available = sqlx::query_scalar("SELECT available FROM books WHERE id = ?1")
        .bind(book_id)
        .fetch_optional(pool)
        .await?;
    Ok(available)
}

/// `(book_uid, path)` for a row, used to phrase a failure issue.
pub async fn book_reference(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<(Option<String>, String)>, AppError> {
    let row: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT book_uid, path FROM books WHERE id = ?1")
            .bind(book_id)
            .fetch_optional(pool)
            .await?;
    Ok(row)
}

/// `hash_state` for one file row; `None` when the row is gone.
pub async fn hash_state(pool: &SqlitePool, book_id: i64) -> Result<Option<String>, AppError> {
    let state = sqlx::query_scalar("SELECT hash_state FROM books WHERE id = ?1")
        .bind(book_id)
        .fetch_optional(pool)
        .await?;
    Ok(state)
}

/// Durable book state from every file location: failed if any location failed,
/// otherwise pending if any is pending, otherwise hashed. `None` when the book
/// has no file rows (Reading history). This is what the library shows, so a
/// failed duplicate cannot hide behind a healthy active copy.
pub async fn aggregate_hash_state(
    pool: &SqlitePool,
    book_id: i64,
) -> Result<Option<String>, AppError> {
    let state: Option<String> = sqlx::query_scalar(
        r#"
        SELECT CASE
            WHEN COUNT(*) = 0 THEN NULL
            WHEN COUNT(*) FILTER (WHERE b.hash_state = 'failed') > 0 THEN 'failed'
            WHEN COUNT(*) FILTER (WHERE b.hash_state = 'pending') > 0 THEN 'pending'
            ELSE 'hashed'
        END
        FROM books b
        JOIN book_records br ON br.uid = b.book_uid
        WHERE br.id = ?1
        "#,
    )
    .bind(book_id)
    .fetch_one(pool)
    .await?;
    Ok(state)
}

/// One path per durable book that still has a failed location, for the sync
/// issue sweep. Grouping here keeps the caller from writing one issue per file
/// row of the same book.
pub async fn failed_book_paths(pool: &SqlitePool) -> Result<Vec<(i64, String)>, AppError> {
    let rows = sqlx::query_as(
        r#"
        SELECT br.id, MIN(b.path)
        FROM books b
        JOIN book_records br ON br.uid = b.book_uid
        WHERE b.hash_state = 'failed'
        GROUP BY br.id
        ORDER BY br.id
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Show a failed row as pending while its retry runs. The retry clock stays
/// until the attempt fails and writes a new one, so a status read during the
/// hash does not report a stale failure.
pub async fn claim_for_retry(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    sqlx::query("UPDATE books SET hash_state = 'pending' WHERE id = ?1 AND hash_state = 'failed'")
        .bind(book_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Mark one attempt as failed. The attempt count grows and the retry clock moves
/// forward on the bounded schedule; `refresh_status` and the backfill loop read
/// both, so the retry needs no in-memory state.
pub async fn mark_hash_failed(pool: &SqlitePool, book_id: i64) -> Result<i64, AppError> {
    let mut tx = pool.begin().await?;
    let attempts: Option<i64> = sqlx::query_scalar(
        "UPDATE books SET hash_attempts = hash_attempts + 1, hash_state = 'failed'
         WHERE id = ?1 RETURNING hash_attempts",
    )
    .bind(book_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(attempts) = attempts else {
        tx.commit().await?;
        return Ok(0);
    };
    sqlx::query("UPDATE books SET hash_retry_at = ?2 WHERE id = ?1")
        .bind(book_id)
        .bind(retry_at_after(attempts))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(attempts)
}

/// Return one row to `pending` with a clean retry budget, so a manual retry
/// starts over instead of inheriting the old backoff.
pub async fn reset_hash_for_retry(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE books SET hash_state = 'pending', hash_attempts = 0, hash_retry_at = NULL
         WHERE id = ?1",
    )
    .bind(book_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_grows_then_caps_at_one_day() {
        let schedule: Vec<i64> = (1..=8).map(retry_delay_secs).collect();
        assert_eq!(
            schedule,
            vec![60, 300, 900, 3_600, 21_600, 86_400, 86_400, 86_400]
        );
        // A zero or negative count still gets the first delay rather than
        // panicking; the count only ever grows in normal use.
        assert_eq!(retry_delay_secs(0), 60);
        assert_eq!(retry_delay_secs(-3), 60);
    }
}
