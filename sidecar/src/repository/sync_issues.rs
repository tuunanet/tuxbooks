//! Persistence for the user-visible sync issues. The sync engine computes what
//! to report; services outside `sync/` also record hash failures, so the SQL
//! lives here instead of in the engine. One open row per issue key is enforced
//! by the partial unique index from migration 0028.

use sqlx::SqlitePool;

use crate::error::AppError;

/// `sync_meta` key for the sync on/off flag. `sync::clock` re-exports it so the
/// key has one owner and services can read it without importing `sync/`.
pub const META_ENABLED: &str = "enabled";

/// Whether cloud sync is enabled. Services outside `sync/` need this to know
/// whether a failure belongs in the issue list; reading the flag here keeps
/// them off the sync module.
pub async fn is_enabled(pool: &SqlitePool) -> Result<bool, AppError> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = ?1")
        .bind(META_ENABLED)
        .fetch_optional(pool)
        .await?;
    Ok(value.as_deref() == Some("1"))
}

/// Record an issue, refreshing the detail when its key already has an open row.
pub async fn record(
    pool: &SqlitePool,
    key: &str,
    kind: &str,
    detail: &str,
    file_name: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO sync_issues (issue_key, kind, detail, file_name)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(issue_key) WHERE resolved_at IS NULL DO UPDATE SET
            kind = excluded.kind,
            detail = excluded.detail,
            file_name = excluded.file_name,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
    )
    .bind(key)
    .bind(kind)
    .bind(detail)
    .bind(file_name)
    .execute(pool)
    .await?;
    Ok(())
}

/// Open one issue, or refresh a changed detail on the existing open row. A
/// status sweep calls this for every failed hash; an unchanged pass leaves
/// `updated_at` alone so the row does not jump in the list.
pub async fn ensure(
    pool: &SqlitePool,
    key: &str,
    kind: &str,
    detail: &str,
    file_name: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO sync_issues (issue_key, kind, detail, file_name)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(issue_key) WHERE resolved_at IS NULL DO UPDATE SET
            kind = excluded.kind,
            detail = excluded.detail,
            file_name = excluded.file_name,
            updated_at = CASE
                WHEN sync_issues.kind IS NOT excluded.kind
                  OR sync_issues.detail IS NOT excluded.detail
                  OR sync_issues.file_name IS NOT excluded.file_name
                THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ELSE sync_issues.updated_at
            END
        "#,
    )
    .bind(key)
    .bind(kind)
    .bind(detail)
    .bind(file_name)
    .execute(pool)
    .await?;
    Ok(())
}

/// Close one open issue by key. A missing row is already resolved.
pub async fn resolve(pool: &SqlitePool, key: &str) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    sqlx::query(
        "UPDATE sync_issues SET resolved_at = ?2 WHERE issue_key = ?1 AND resolved_at IS NULL",
    )
    .bind(key)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}
