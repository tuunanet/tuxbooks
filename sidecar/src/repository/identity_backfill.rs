//! Queries for the background content-hash pass. The orchestration lives in
//! `services::hash_backfill`; SQL stays here.

use sqlx::SqlitePool;

use crate::error::AppError;

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

/// Book ids whose bytes still need hashing, oldest row first.
pub async fn pending_book_ids(pool: &SqlitePool, limit: i64) -> Result<Vec<i64>, AppError> {
    let ids = sqlx::query_scalar(
        "SELECT id FROM books
         WHERE hash_state = 'pending' AND available = 1
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

pub async fn mark_hash_failed(pool: &SqlitePool, book_id: i64) -> Result<(), AppError> {
    sqlx::query("UPDATE books SET hash_state = 'failed' WHERE id = ?1")
        .bind(book_id)
        .execute(pool)
        .await?;
    Ok(())
}
