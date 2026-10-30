//! Relink issues (ADR 0014 D10).
//!
//! A failed content hash is recorded here so the book keeps a durable record
//! and can be found again after a relink. Identity merges are automatic and
//! keep their audit trail in `sync_book_merges` instead. The open list and
//! dismiss helpers stay for the hash-retry path that clears these rows.

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationIssue {
    pub id: i64,
    pub issue_key: String,
    pub kind: String,
    pub detail: String,
    pub book_uid: Option<String>,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

/// Record an issue without duplicating an open row for the same key.
pub async fn record_issue(
    pool: &SqlitePool,
    key: &str,
    kind: &str,
    detail: &str,
    book_uid: Option<&str>,
) -> Result<(), AppError> {
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM migration_issues WHERE issue_key = ?1 AND resolved_at IS NULL LIMIT 1",
    )
    .bind(key)
    .fetch_optional(pool)
    .await?;
    if let Some(id) = existing {
        sqlx::query(
            "UPDATE migration_issues SET kind = ?2, detail = ?3, book_uid = ?4 WHERE id = ?1",
        )
        .bind(id)
        .bind(kind)
        .bind(detail)
        .bind(book_uid)
        .execute(pool)
        .await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO migration_issues (issue_key, kind, detail, book_uid) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(key)
    .bind(kind)
    .bind(detail)
    .bind(book_uid)
    .execute(pool)
    .await?;
    Ok(())
}

/// Open issues, newest first.
pub async fn list_open(pool: &SqlitePool) -> Result<Vec<MigrationIssue>, AppError> {
    let issues = sqlx::query_as::<_, MigrationIssue>(
        "SELECT id, issue_key, kind, detail, book_uid, created_at, resolved_at
         FROM migration_issues
         WHERE resolved_at IS NULL
         ORDER BY created_at DESC, id DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(issues)
}

/// Dismiss one issue. Returns false when the id does not exist (already
/// dismissed or never present), so the caller can answer 1:1.
pub async fn dismiss(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE migration_issues
         SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND resolved_at IS NULL",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
