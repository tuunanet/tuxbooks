//! Alias resolution: which live identity a content hash or stale uuid maps to.

use sqlx::SqlitePool;

use crate::error::AppError;

/// The durable uid a content hash is already known by, if any. Relink uses
/// this to refuse attaching a file whose bytes belong to another book.
pub(crate) async fn alias_book_uid(
    pool: &SqlitePool,
    content_hash: &str,
) -> Result<Option<String>, AppError> {
    let uid: Option<String> =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(content_hash)
            .fetch_optional(pool)
            .await?;
    Ok(uid)
}

pub async fn canonical_book_uid(pool: &SqlitePool, uid: &str) -> Result<String, AppError> {
    let mut current = uid.to_string();
    for _ in 0..32 {
        let next: Option<String> =
            sqlx::query_scalar("SELECT winner FROM sync_book_merges WHERE loser = ?1")
                .bind(&current)
                .fetch_optional(pool)
                .await?;
        match next {
            Some(next) if next != current => current = next,
            _ => break,
        }
    }
    Ok(current)
}

/// Whether `uid` (after identity merges) has an open shared Forget. `None`
/// means the identity is live; `Some(replacement)` means it was forgotten,
/// with the fresh identity the current file was rebound to, when there is one.
pub(crate) async fn forgotten_replacement(
    pool: &SqlitePool,
    uid: &str,
) -> Result<Option<Option<String>>, AppError> {
    let canonical = canonical_book_uid(pool, uid).await?;
    let replacement: Option<Option<String>> = sqlx::query_scalar(
        "SELECT replacement_book_uid FROM sync_book_trash
         WHERE book_uid = ?1 AND restored_at IS NULL",
    )
    .bind(&canonical)
    .fetch_optional(pool)
    .await?;
    Ok(replacement)
}

/// Resolve a candidate identity for alias selection. A forgotten uuid is not
/// a candidate; its fresh replacement is, so both machines keep the bytes under
/// one live identity.
pub(super) async fn resolve_identity(
    pool: &SqlitePool,
    uid: &str,
) -> Result<Option<String>, AppError> {
    let uid = canonical_book_uid(pool, uid).await?;
    Ok(match forgotten_replacement(pool, &uid).await? {
        Some(Some(replacement)) => Some(replacement),
        Some(None) => None,
        None => Some(uid),
    })
}
