//! Reading-history decoration and empty-duplicate detach (ADR 0019 D2).

use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::domain::ReadingHistoryBook;
use crate::error::AppError;
use crate::repository::books;

/// Reading-history rows with the local empty-duplicate label joined in.
pub async fn list(
    pool: &SqlitePool,
    match_query: Option<&str>,
) -> Result<Vec<ReadingHistoryBook>, AppError> {
    let mut rows = books::list_reading_history(pool, match_query).await?;
    if rows.is_empty() {
        return Ok(rows);
    }
    let labels: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT dd.book_uid, COALESCE(owner.title, dd.duplicate_of_title)
         FROM book_detached_duplicates dd
         LEFT JOIN book_records owner ON owner.uid = dd.duplicate_of_uid",
    )
    .fetch_all(pool)
    .await?;
    let labels: HashMap<String, Option<String>> = labels.into_iter().collect();
    for row in &mut rows {
        if let Some(title) = labels.get(&row.book_uid) {
            row.is_empty_duplicate = true;
            row.duplicate_of_title = title.clone();
        }
    }
    Ok(rows)
}

/// Drop the stale file rows and record the entry that owns the picked bytes,
/// in one transaction. The durable record stays for Reading history and keeps
/// the Last known path of the copy the reader opened (tuxbooks-t9p.1).
pub async fn detach_duplicate(
    pool: &SqlitePool,
    id: i64,
    duplicate_of_uid: &str,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO book_detached_duplicates
             (book_uid, duplicate_of_uid, duplicate_of_title)
         SELECT uid, ?2, (SELECT title FROM book_records WHERE uid = ?2)
         FROM book_records WHERE id = ?1
         ON CONFLICT(book_uid) DO UPDATE SET
             duplicate_of_uid = excluded.duplicate_of_uid,
             duplicate_of_title = excluded.duplicate_of_title,
             detached_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    )
    .bind(id)
    .bind(duplicate_of_uid)
    .execute(&mut *tx)
    .await?;
    let uid: Option<String> =
        sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(uid) = uid else {
        return Ok(());
    };
    let active_path = books::active_path_for_uid(&mut *tx, &uid).await?;
    sqlx::query("DELETE FROM books WHERE book_uid = ?1")
        .bind(&uid)
        .execute(&mut *tx)
        .await?;
    books::remember_last_known_path(&mut *tx, &uid, active_path).await?;
    tx.commit().await?;
    Ok(())
}
