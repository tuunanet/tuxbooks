//! The issue list surface: read rows, dismiss informational ones.

use sqlx::SqlitePool;

use crate::error::AppError;

use super::{SyncIssue, SyncIssueAction};
use crate::sync::clock::now_rfc3339;

impl super::SyncService {
    pub async fn issues(&self) -> Result<Vec<SyncIssue>, AppError> {
        type Row = (
            i64,
            String,
            String,
            String,
            Option<String>,
            String,
            String,
            i64,
            Option<String>,
        );
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, issue_key, kind, detail, file_name, created_at, updated_at,
                    auto_attempts, next_auto_retry_at
                 FROM sync_issues
                 WHERE resolved_at IS NULL AND kind <> 'conflict'
                 ORDER BY updated_at DESC, id DESC LIMIT 100",
        )
        .fetch_all(&self.inner.pool)
        .await?;
        let mut issues = Vec::with_capacity(rows.len());
        for (
            id,
            issue_key,
            kind,
            detail,
            file_name,
            created_at,
            updated_at,
            auto_attempts,
            next_auto_retry_at,
        ) in rows
        {
            let target =
                issue_target(&self.inner.pool, &kind, &issue_key, file_name.as_deref()).await;
            issues.push(SyncIssue {
                id,
                action: SyncIssueAction::for_kind(&kind),
                kind,
                detail,
                file_name,
                target,
                created_at,
                updated_at,
                auto_attempts,
                next_auto_retry_at,
            });
        }
        Ok(issues)
    }

    /// Dismiss one informational row. Actionable rows refuse: they stay until
    /// the condition clears or the retry runs.
    pub async fn dismiss_issue(&self, id: i64) -> Result<bool, AppError> {
        let kind: Option<String> = sqlx::query_scalar(
            "SELECT kind FROM sync_issues WHERE id = ?1 AND resolved_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&self.inner.pool)
        .await?;
        let Some(kind) = kind else {
            return Ok(false);
        };
        // Conflict-kind rows are invisible diagnostics; only the reconcile and
        // expiry sweep closes them. Dismissing one would hide a legacy row
        // nothing else can account for.
        if kind == "conflict" {
            return Ok(false);
        }
        if !SyncIssueAction::for_kind(&kind).is_informational() {
            return Err(AppError::InvalidInput(
                "this sync issue has an action; retry it or fix it in the sync folder".into(),
            ));
        }
        let result = sqlx::query(
            "UPDATE sync_issues SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL",
        )
        .bind(id)
        .bind(now_rfc3339())
        .execute(&self.inner.pool)
        .await?;
        if result.rows_affected() > 0 {
            self.refresh_status().await?;
            self.emit_status();
        }
        Ok(result.rows_affected() > 0)
    }

    /// Dismiss every informational issue. Actionable rows stay open: hiding a
    /// row the app can still repair would make the problem look gone.
    pub async fn dismiss_all_issues(&self) -> Result<usize, AppError> {
        let rows: Vec<(i64, String)> =
            sqlx::query_as("SELECT id, kind FROM sync_issues WHERE resolved_at IS NULL")
                .fetch_all(&self.inner.pool)
                .await?;
        let ids: Vec<i64> = rows
            .into_iter()
            .filter(|(_, kind)| {
                kind != "conflict" && SyncIssueAction::for_kind(kind).is_informational()
            })
            .map(|(id, _)| id)
            .collect();
        if ids.is_empty() {
            return Ok(0);
        }
        let now = now_rfc3339();
        let mut tx = self.inner.pool.begin().await?;
        for id in &ids {
            sqlx::query(
                "UPDATE sync_issues SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL",
            )
            .bind(id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.refresh_status().await?;
        Ok(ids.len())
    }
}

/// Short human label for an issue row. Keys carry internal ids; the UI gets a
/// title, a relative file, or a kind name instead.
async fn issue_target(
    pool: &SqlitePool,
    kind: &str,
    issue_key: &str,
    file_name: Option<&str>,
) -> String {
    let suffix = issue_key
        .split_once(':')
        .map(|(_, value)| value)
        .unwrap_or(issue_key);
    match kind {
        "sync_failed" => "Sync pass".to_string(),
        "projection_failed" | "identity_failed" => match suffix.parse::<i64>() {
            Ok(book_id) => match file_book_title(pool, book_id).await {
                Some(title) => title,
                None => format!("Book {book_id}"),
            },
            Err(_) => issue_key.to_string(),
        },
        // A hash failure is keyed by the durable book id, so the label comes
        // from the durable record rather than a file row.
        "hash_failed" => match suffix.parse::<i64>() {
            Ok(book_id) => match record_book_title(pool, book_id).await {
                Some(title) => title,
                None => format!("Book {book_id}"),
            },
            Err(_) => issue_key.to_string(),
        },
        "duplicate_book" => {
            let uid = suffix.split(':').next().unwrap_or(suffix);
            durable_book_title(pool, uid)
                .await
                .unwrap_or_else(|| format!("Book {}", short_uid(uid)))
        }
        "reprojection_failed"
        | "book_lifecycle_failed"
        | "book_snapshot_missing"
        | "book_snapshot_invalid" => durable_book_title(pool, suffix)
            .await
            .unwrap_or_else(|| format!("Book {}", short_uid(suffix))),
        "operation_retrying" | "operation_rejected" | "cover_missing" | "cover_blob_failed"
        | "invalid_dirty_kind" => suffix.to_string(),
        _ => file_name.unwrap_or(suffix).to_string(),
    }
}

async fn file_book_title(pool: &SqlitePool, book_id: i64) -> Option<String> {
    sqlx::query_scalar("SELECT title FROM books WHERE id = ?1")
        .bind(book_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn record_book_title(pool: &SqlitePool, book_id: i64) -> Option<String> {
    sqlx::query_scalar("SELECT title FROM book_records WHERE id = ?1")
        .bind(book_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn durable_book_title(pool: &SqlitePool, book_uid: &str) -> Option<String> {
    sqlx::query_scalar("SELECT title FROM book_records WHERE uid = ?1")
        .bind(book_uid)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

fn short_uid(uid: &str) -> String {
    uid.chars().take(8).collect()
}
