//! Issue auto-resolution: is the condition behind a row gone, and close it.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::error::AppError;

use crate::sync::clock::now_rfc3339;
use crate::sync::model::Op;
use crate::sync::store;

impl super::SyncService {
    /// True when the condition behind one issue has cleared. This is the one
    /// place that decides auto-resolution, shared by the status sweep and the
    /// retry outcome check. Conflicts are never cleared here.
    async fn issue_cleared(
        &self,
        kind: &str,
        issue_key: &str,
        file_name: Option<&str>,
    ) -> Result<bool, AppError> {
        let root = self.sync_root();
        match kind {
            "duplicate_book" => match issue_key
                .strip_prefix("duplicate-book:")
                .and_then(|rest| rest.split(':').next())
            {
                Some(uid) => Ok(self.binding_count(uid).await? < 2),
                None => Ok(false),
            },
            "operation_retrying" | "operation_rejected" => match issue_key.strip_prefix("file:") {
                Some(relative) => self.operation_cleared(relative, root.as_deref()).await,
                None => Ok(false),
            },
            "cover_missing" => match issue_key.strip_prefix("cover-missing:") {
                Some(name) => self.cover_applied(name, file_name).await,
                None => Ok(false),
            },
            "cover_blob_failed" => match issue_key.strip_prefix("cover:") {
                Some(name) => Ok(root
                    .as_deref()
                    .is_some_and(|root| store::cover_blob_exists(root, name))),
                None => Ok(false),
            },
            "projection_failed" => match issue_key.strip_prefix("project-book:") {
                Some(rest) => match rest.parse::<i64>() {
                    Ok(book_id) => Ok(!self.book_row_exists(book_id).await?),
                    Err(_) => Ok(false),
                },
                None => Ok(false),
            },
            "identity_failed" => match issue_key.strip_prefix("identity:") {
                Some(rest) => match rest.parse::<i64>() {
                    Ok(book_id) => Ok(!self.book_row_exists(book_id).await?),
                    Err(_) => Ok(false),
                },
                None => Ok(false),
            },
            // A hash row clears only when the whole book is hashed. `pending`
            // is the claimed state during an attempt, and `failed` is the
            // result; closing on either would drop the issue mid-retry and
            // reopen it with a new id on the next failure.
            "hash_failed" => match issue_key.strip_prefix("hash-failed:") {
                Some(rest) => match rest.parse::<i64>() {
                    Ok(book_id) => match self.book_hash_state(book_id).await? {
                        None => Ok(true),
                        Some(state) => Ok(state == "hashed"),
                    },
                    Err(_) => Ok(false),
                },
                None => Ok(false),
            },
            "reprojection_failed" => match issue_key.strip_prefix("reproject:") {
                Some(uid) => {
                    Ok(!self.book_record_exists(uid).await? && self.binding_count(uid).await? == 0)
                }
                None => Ok(false),
            },
            "book_lifecycle_failed" => match issue_key.strip_prefix("book-lifecycle:") {
                Some(uid) => Ok(!self.book_record_exists(uid).await?),
                None => Ok(false),
            },
            // Conflicts belong to review. Informational rows have no
            // automatic condition.
            _ => Ok(false),
        }
    }

    /// Close open rows whose condition has cleared.
    pub(super) async fn resolve_cleared_issues(&self) -> Result<u64, AppError> {
        let rows: Vec<(i64, String, String, Option<String>)> = sqlx::query_as(
            "SELECT id, issue_key, kind, file_name FROM sync_issues
             WHERE resolved_at IS NULL",
        )
        .fetch_all(&self.inner.pool)
        .await?;
        if rows.is_empty() {
            return Ok(0);
        }
        let mut cleared = Vec::new();
        for (id, issue_key, kind, file_name) in rows {
            if self
                .issue_cleared(&kind, &issue_key, file_name.as_deref())
                .await?
            {
                cleared.push(id);
            }
        }
        if cleared.is_empty() {
            return Ok(0);
        }
        let now = now_rfc3339();
        let mut tx = self.inner.pool.begin().await?;
        for id in &cleared {
            sqlx::query(
                "UPDATE sync_issues SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL",
            )
            .bind(id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(cleared.len() as u64)
    }

    async fn binding_count(&self, book_uid: &str) -> Result<i64, AppError> {
        Ok(
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_bindings WHERE book_uid = ?1")
                .bind(book_uid)
                .fetch_one(&self.inner.pool)
                .await?,
        )
    }

    async fn book_row_exists(&self, book_id: i64) -> Result<bool, AppError> {
        let row: Option<i64> = sqlx::query_scalar("SELECT 1 FROM books WHERE id = ?1")
            .bind(book_id)
            .fetch_optional(&self.inner.pool)
            .await?;
        Ok(row.is_some())
    }

    async fn book_hash_state(&self, book_id: i64) -> Result<Option<String>, AppError> {
        crate::repository::identity_backfill::aggregate_hash_state(&self.inner.pool, book_id).await
    }

    async fn book_record_exists(&self, book_uid: &str) -> Result<bool, AppError> {
        let row: Option<i64> = sqlx::query_scalar("SELECT 1 FROM book_records WHERE uid = ?1")
            .bind(book_uid)
            .fetch_optional(&self.inner.pool)
            .await?;
        Ok(row.is_some())
    }

    /// A file is done when its current cache row says it applied cleanly, or
    /// when it is gone. A stale applied-op row from an earlier version of the
    /// same path does not count.
    pub(super) async fn operation_cleared(
        &self,
        relative: &str,
        root: Option<&Path>,
    ) -> Result<bool, AppError> {
        let row: Option<(Option<String>, i64)> = sqlx::query_as(
            "SELECT processed_at, failures FROM sync_remote_files WHERE relative_path = ?1",
        )
        .bind(relative)
        .fetch_optional(&self.inner.pool)
        .await?;
        if row.is_some_and(|(processed_at, failures)| processed_at.is_some() && failures == 0) {
            return Ok(true);
        }
        let Some(root) = root else {
            return Ok(false);
        };
        let Some(path) = safe_sync_path(root, relative) else {
            return Ok(false);
        };
        Ok(!path.exists())
    }

    /// The cover counts as applied only when this book's effective cover is
    /// the blob named by the issue. A blob sitting in the folder is not enough.
    async fn cover_applied(&self, name: &str, file_name: Option<&str>) -> Result<bool, AppError> {
        let Some(root) = self.sync_root() else {
            return Ok(false);
        };
        let Some(relative) = file_name else {
            return Ok(false);
        };
        let Ok(op) = read_sync_op(&root, relative) else {
            return Ok(false);
        };
        let book_uid = op.book_uid.unwrap_or(op.entity_uid);
        let cover: Option<Option<String>> =
            sqlx::query_scalar("SELECT cover_path FROM book_records WHERE uid = ?1")
                .bind(&book_uid)
                .fetch_optional(&self.inner.pool)
                .await?;
        Ok(cover.flatten().is_some_and(|path| {
            Path::new(&path).file_name().and_then(|file| file.to_str()) == Some(name)
        }))
    }
}

/// True when an issue with this internal key is still open.
pub(super) async fn issue_key_open(pool: &SqlitePool, issue_key: &str) -> Result<bool, AppError> {
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sync_issues WHERE issue_key = ?1 AND resolved_at IS NULL LIMIT 1",
    )
    .bind(issue_key)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Close one issue by its internal key. Used by natural repair paths.
pub(super) async fn resolve_issue_key(pool: &SqlitePool, issue_key: &str) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE sync_issues SET resolved_at = ?2
         WHERE issue_key = ?1 AND resolved_at IS NULL",
    )
    .bind(issue_key)
    .bind(now_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

/// Join a folder-relative issue path without allowing traversal.
fn safe_sync_path(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.starts_with('/') || relative.split('/').any(|part| part == "..") {
        return None;
    }
    Some(root.join(relative))
}

/// Read the operation behind an issue row. Unreadable files are reported as a
/// failed repair, never guessed at.
pub(super) fn read_sync_op(root: &Path, relative: &str) -> Result<Op, AppError> {
    let path = safe_sync_path(root, relative).ok_or_else(|| {
        AppError::InvalidInput("the operation path in this issue is not safe to read".into())
    })?;
    store::read_op(&path)
        .map_err(|err| AppError::InvalidInput(format!("the operation file is not readable: {err}")))
}
