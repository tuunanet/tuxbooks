use sqlx::SqlitePool;

use crate::domain::{ProviderLink, ProviderReadingStatus};
use crate::error::AppError;

/// Every link, used to decorate book payloads with their provider rows. The
/// table is small (one row per linked book and provider).
pub async fn list_all_links(pool: &SqlitePool) -> Result<Vec<ProviderLink>, AppError> {
    let links = sqlx::query_as::<_, ProviderLink>(
        "SELECT book_uid, provider, remote_id, status, status_updated_at, \
                linked_at, updated_at \
         FROM book_provider_links ORDER BY linked_at, provider",
    )
    .fetch_all(pool)
    .await?;
    Ok(links)
}

pub async fn list_links(pool: &SqlitePool, book_uid: &str) -> Result<Vec<ProviderLink>, AppError> {
    let links = sqlx::query_as::<_, ProviderLink>(
        "SELECT book_uid, provider, remote_id, status, status_updated_at, \
                linked_at, updated_at \
         FROM book_provider_links WHERE book_uid = ?1 ORDER BY linked_at, provider",
    )
    .bind(book_uid)
    .fetch_all(pool)
    .await?;
    Ok(links)
}

pub async fn get_link(
    pool: &SqlitePool,
    book_uid: &str,
    provider: &str,
) -> Result<Option<ProviderLink>, AppError> {
    let link = sqlx::query_as::<_, ProviderLink>(
        "SELECT book_uid, provider, remote_id, status, status_updated_at, \
                linked_at, updated_at \
         FROM book_provider_links WHERE book_uid = ?1 AND provider = ?2",
    )
    .bind(book_uid)
    .bind(provider)
    .fetch_optional(pool)
    .await?;
    Ok(link)
}

/// The local book another link already claims on the same provider. Used to
/// reject two durable books pointing at one remote record.
pub async fn find_book_uid_by_remote(
    pool: &SqlitePool,
    provider: &str,
    remote_id: &str,
) -> Result<Option<String>, AppError> {
    let book_uid: Option<String> = sqlx::query_scalar(
        "SELECT book_uid FROM book_provider_links WHERE provider = ?1 AND remote_id = ?2",
    )
    .bind(provider)
    .bind(remote_id)
    .fetch_optional(pool)
    .await?;
    Ok(book_uid)
}

/// Insert or replace a link. Re-pointing an existing link at a different
/// remote record clears the cached status because it belonged to the old
/// record. Returns the stored row, or `None` when the durable book is gone.
pub async fn upsert_link(
    pool: &SqlitePool,
    book_uid: &str,
    provider: &str,
    remote_id: &str,
) -> Result<Option<ProviderLink>, AppError> {
    let link = sqlx::query_as::<_, ProviderLink>(
        r#"
        INSERT INTO book_provider_links (book_uid, provider, remote_id)
        SELECT uid, ?2, ?3 FROM book_records WHERE uid = ?1
        ON CONFLICT(book_uid, provider) DO UPDATE SET
            status = CASE
                WHEN book_provider_links.remote_id = excluded.remote_id
                THEN book_provider_links.status
                ELSE NULL
            END,
            status_updated_at = CASE
                WHEN book_provider_links.remote_id = excluded.remote_id
                THEN book_provider_links.status_updated_at
                ELSE NULL
            END,
            remote_id = excluded.remote_id,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        RETURNING book_uid, provider, remote_id, status, status_updated_at,
                  linked_at, updated_at
        "#,
    )
    .bind(book_uid)
    .bind(provider)
    .bind(remote_id)
    .fetch_optional(pool)
    .await?;
    Ok(link)
}

/// Remove a link. The provider's remote history is untouched; only the local
/// association and its queued page-turn go away.
pub async fn delete_link(
    pool: &SqlitePool,
    book_uid: &str,
    provider: &str,
) -> Result<bool, AppError> {
    let result =
        sqlx::query("DELETE FROM book_provider_links WHERE book_uid = ?1 AND provider = ?2")
            .bind(book_uid)
            .bind(provider)
            .execute(pool)
            .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn update_status(
    pool: &SqlitePool,
    book_uid: &str,
    provider: &str,
    status: ProviderReadingStatus,
) -> Result<ProviderLink, AppError> {
    let link = sqlx::query_as::<_, ProviderLink>(
        r#"
        UPDATE book_provider_links
        SET status = ?3,
            status_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE book_uid = ?1 AND provider = ?2
        RETURNING book_uid, provider, remote_id, status, status_updated_at,
                  linked_at, updated_at
        "#,
    )
    .bind(book_uid)
    .bind(provider)
    .bind(status)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(link)
}

/// Queue one outgoing page-turn for every provider linked to the book. The
/// write is skipped entirely when the book has no file row: with no file
/// open there is no local page turn to send (ADR 0014 D11). A later page turn
/// replaces the queued value, so the queue holds at most one row per link.
pub async fn queue_progress_for_book(
    pool: &SqlitePool,
    book_id: i64,
    progress_percent: f64,
) -> Result<u64, AppError> {
    let result = sqlx::query(
        r#"
        INSERT INTO book_provider_pending_progress
            (book_uid, provider, progress_percent)
        SELECT l.book_uid, l.provider, ?2
        FROM book_provider_links l
        WHERE l.book_uid = (SELECT uid FROM book_records WHERE id = ?1)
          AND EXISTS (SELECT 1 FROM books b WHERE b.book_uid = l.book_uid)
        ON CONFLICT(book_uid, provider) DO UPDATE SET
            progress_percent = excluded.progress_percent,
            queued_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
    )
    .bind(book_id)
    .bind(progress_percent)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn pending_progress(
    pool: &SqlitePool,
    book_uid: &str,
    provider: &str,
) -> Result<Option<f64>, AppError> {
    let progress: Option<f64> = sqlx::query_scalar(
        "SELECT progress_percent FROM book_provider_pending_progress \
         WHERE book_uid = ?1 AND provider = ?2",
    )
    .bind(book_uid)
    .bind(provider)
    .fetch_optional(pool)
    .await?;
    Ok(progress)
}

/// Durable book id for a `book_uid`; the provider commands address books by
/// uid while progress storage still takes the numeric id.
pub async fn book_id_for_uid(pool: &SqlitePool, book_uid: &str) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
        .bind(book_uid)
        .fetch_optional(pool)
        .await?;
    Ok(id)
}
