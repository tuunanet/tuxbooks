//! Persistence for the user-visible sync issues. The sync engine computes what
//! to report; services outside `sync/` also record hash failures, so the SQL
//! lives here instead of in the engine. One open row per issue key is enforced
//! by the partial unique index from migration 0028.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::kind::SyncIssueKind;

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
    kind: SyncIssueKind,
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
    .bind(kind.as_str())
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
    kind: SyncIssueKind,
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
    .bind(kind.as_str())
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

/// Close one open issue by row id, stamping `now`. Returns how many rows
/// actually flipped: the `resolved_at IS NULL` guard makes a repeat call a
/// no-op, so a row that is already closed keeps its original stamp. Takes an
/// executor so batch callers can run their whole sweep inside one transaction.
pub async fn resolve_by_id<'e, E>(executor: E, id: i64, now: &str) -> Result<u64, AppError>
where
    E: sqlx::SqliteExecutor<'e>,
{
    let result = sqlx::query(
        "UPDATE sync_issues SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL",
    )
    .bind(id)
    .bind(now)
    .execute(executor)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn open_row_id(pool: &SqlitePool, key: &str) -> i64 {
        sqlx::query_scalar("SELECT id FROM sync_issues WHERE issue_key = ?1")
            .bind(key)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn resolve_by_id_closes_one_open_row_exactly_once() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        record(&pool, "alpha", SyncIssueKind::SyncFailed, "boom", None)
            .await
            .unwrap();
        let alpha = open_row_id(&pool, "alpha").await;

        let flipped = resolve_by_id(&pool, alpha, "2026-11-14T00:00:00.000Z")
            .await
            .unwrap();
        assert_eq!(flipped, 1);

        // The resolved_at IS NULL guard makes the second call a no-op: it
        // reports zero affected rows and leaves the first stamp in place.
        let again = resolve_by_id(&pool, alpha, "2026-11-14T00:00:01.000Z")
            .await
            .unwrap();
        assert_eq!(again, 0);
        let stamp: Option<String> =
            sqlx::query_scalar("SELECT resolved_at FROM sync_issues WHERE id = ?1")
                .bind(alpha)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stamp.as_deref(), Some("2026-11-14T00:00:00.000Z"));
    }

    #[tokio::test]
    async fn resolve_by_id_leaves_other_rows_open() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        record(&pool, "alpha", SyncIssueKind::SyncFailed, "boom", None)
            .await
            .unwrap();
        record(&pool, "beta", SyncIssueKind::SyncFailed, "bang", None)
            .await
            .unwrap();
        let alpha = open_row_id(&pool, "alpha").await;
        let beta = open_row_id(&pool, "beta").await;

        resolve_by_id(&pool, alpha, "2026-11-14T00:00:00.000Z")
            .await
            .unwrap();

        let beta_stamp: Option<String> =
            sqlx::query_scalar("SELECT resolved_at FROM sync_issues WHERE id = ?1")
                .bind(beta)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(beta_stamp.is_none(), "another row's id must stay open");
    }
}
