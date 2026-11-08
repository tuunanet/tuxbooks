//! The Retry action: run one issue's repair path under the pass lock.

use std::path::Path;

use crate::error::AppError;

use super::autoretry::STRIP_AUTO_RETRY_STATE;
use super::clear::read_sync_op;
use super::SyncIssueAction;
use crate::sync::clock::now_rfc3339;
use crate::sync::identity::ensure_book_identity;
use crate::sync::merge;
use crate::sync::store;

impl super::SyncService {
    /// Run the action behind one retryable issue. Returns true when the row
    /// was resolved, false when the row was already gone or the work ran but
    /// the condition is still there. A failed attempt updates the detail and
    /// stays open.
    pub async fn retry_issue(&self, id: i64) -> Result<bool, AppError> {
        let row: Option<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT issue_key, kind, file_name FROM sync_issues
             WHERE id = ?1 AND resolved_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&self.inner.pool)
        .await?;
        let Some((issue_key, kind, file_name)) = row else {
            return Ok(false);
        };
        if SyncIssueAction::for_kind(&kind) != SyncIssueAction::Retry {
            return Err(AppError::InvalidInput(
                "this sync issue is not retryable; use its listed action".into(),
            ));
        }

        let _guard = self.inner.pass_lock.lock().await;
        // A human press grants a fresh budget (ADR 0017 D4): the auto-retry
        // count resets and an exhausted row revives, its gave-up detail
        // stripped so only live state stays on the row.
        sqlx::query(&format!(
            "UPDATE sync_issues SET
                auto_attempts = 0,
                next_auto_retry_at = NULL,
                detail = {STRIP_AUTO_RETRY_STATE},
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND resolved_at IS NULL"
        ))
        .bind(id)
        .execute(&self.inner.pool)
        .await?;
        let outcome = self
            .retry_locked(&kind, &issue_key, file_name.as_deref())
            .await;
        match outcome {
            Ok(cleared) => {
                // A retry can hash a file and merge its durable identity, even
                // while sync is off; drain the merge marker here instead of
                // waiting for the next pass.
                self.flush_library_reload().await?;
                // A pass may have closed the row itself (sync_failed). The
                // retry path reports whether the condition is actually gone;
                // never close on Ok alone.
                if !self.issue_is_open(id).await? || cleared {
                    sqlx::query(
                        "UPDATE sync_issues SET resolved_at = ?2
                         WHERE id = ?1 AND resolved_at IS NULL",
                    )
                    .bind(id)
                    .bind(now_rfc3339())
                    .execute(&self.inner.pool)
                    .await?;
                    self.refresh_status().await?;
                    self.emit_status();
                    Ok(true)
                } else {
                    self.keep_issue_open(id).await?;
                    self.refresh_status().await?;
                    self.emit_status();
                    Ok(false)
                }
            }
            Err(err) => {
                let detail = format!("retry failed: {err}");
                let _ = sqlx::query(
                    "UPDATE sync_issues
                     SET detail = ?2,
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     WHERE id = ?1 AND resolved_at IS NULL",
                )
                .bind(id)
                .bind(&detail)
                .execute(&self.inner.pool)
                .await;
                self.refresh_status().await?;
                self.emit_status();
                Err(err)
            }
        }
    }

    /// Run the retry path for one kind. The caller holds `pass_lock` — either
    /// the manual entry point above or the auto-retry sweep. Returns true
    /// when the work itself proves the condition is gone.
    pub(super) async fn retry_locked(
        &self,
        kind: &str,
        issue_key: &str,
        file_name: Option<&str>,
    ) -> Result<bool, AppError> {
        // Indexing is local work. It must not depend on the sync folder still
        // being connected, or a detached device could never retry the hash
        // behind a row that is already listed. The issue key holds the durable
        // book id, so every location is retried together.
        if kind == "hash_failed" {
            let book_id = parse_key_i64(issue_key, "hash-failed:")?;
            let outcome =
                crate::services::hash_backfill::retry_book(&self.inner.pool, book_id).await?;
            return Ok(outcome.hash_state == crate::domain::IndexingRetry::HASHED);
        }
        let folder = self.status_snapshot().folder.ok_or_else(|| {
            AppError::InvalidInput("sync is not connected; reconnect the sync folder".into())
        })?;
        let root = store::resolve_root(Path::new(&folder))?;
        match kind {
            "projection_failed" => {
                let book_id = parse_key_i64(issue_key, "project-book:")?;
                self.reproject_file_row(book_id, &root).await?;
                Ok(true)
            }
            "identity_failed" => {
                let book_id = parse_key_i64(issue_key, "identity:")?;
                match ensure_book_identity(&self.inner.pool, book_id).await? {
                    Some(identity) => {
                        merge::project_book(
                            &self.inner.pool,
                            &identity.book_uid,
                            &root,
                            &self.inner.covers_dir,
                        )
                        .await?;
                        Ok(true)
                    }
                    None => {
                        self.book_gone(book_id).await?;
                        Ok(true)
                    }
                }
            }
            "reprojection_failed" => {
                let book_uid = parse_key(issue_key, "reproject:")?;
                self.reproject_book_or_gone(&book_uid, &root).await?;
                Ok(true)
            }
            "book_lifecycle_failed" => {
                let book_uid = parse_key(issue_key, "book-lifecycle:")?;
                if !merge::retry_book_lifecycle(&self.inner.pool, &book_uid).await? {
                    // Nothing in the mirror to replay. Leave the row open so a
                    // later pass or restore can still settle it.
                    return Ok(false);
                }
                if !self.status_snapshot().enabled {
                    return Ok(true);
                }
                self.run_pass_locked().await?;
                Ok(true)
            }
            "sync_failed" => {
                if !self.status_snapshot().enabled {
                    return Err(AppError::InvalidInput(
                        "sync is not connected; reconnect the sync folder".into(),
                    ));
                }
                self.run_pass_locked().await?;
                Ok(true)
            }
            "operation_retrying" => {
                // Drop the cached failure so the next pass reads the file
                // again instead of skipping it as already processed.
                let relative = parse_key(issue_key, "file:")?;
                sqlx::query("DELETE FROM sync_remote_files WHERE relative_path = ?1")
                    .bind(&relative)
                    .execute(&self.inner.pool)
                    .await?;
                if !self.status_snapshot().enabled {
                    return Err(AppError::InvalidInput(
                        "sync is not connected; reconnect the sync folder".into(),
                    ));
                }
                self.run_pass_locked().await?;
                self.operation_cleared(&relative, Some(&root)).await
            }
            "cover_missing" => {
                let name = parse_key(issue_key, "cover-missing:")?;
                self.apply_missing_cover(&name, file_name, &root).await?;
                Ok(true)
            }
            "cover_blob_failed" => {
                let name = parse_key(issue_key, "cover:")?;
                store::store_cover_blob(&root, &self.inner.covers_dir, &name)?;
                Ok(store::cover_blob_exists(&root, &name))
            }
            other => Err(AppError::InvalidInput(format!(
                "sync issue kind {other} has no retry path"
            ))),
        }
    }

    /// Resolve a file-row id to its durable book and project that book.
    async fn reproject_file_row(&self, book_id: i64, root: &Path) -> Result<(), AppError> {
        let book_uid: Option<String> =
            sqlx::query_scalar("SELECT book_uid FROM books WHERE id = ?1")
                .bind(book_id)
                .fetch_optional(&self.inner.pool)
                .await?
                .flatten();
        match book_uid {
            Some(book_uid) => {
                merge::project_book(&self.inner.pool, &book_uid, root, &self.inner.covers_dir)
                    .await?;
                Ok(())
            }
            // The row disappeared before a binding existed, or a fresh import
            // has not hashed it yet. Hashing here repairs both cases.
            None => match ensure_book_identity(&self.inner.pool, book_id).await? {
                Some(identity) => {
                    merge::project_book(
                        &self.inner.pool,
                        &identity.book_uid,
                        root,
                        &self.inner.covers_dir,
                    )
                    .await?;
                    Ok(())
                }
                None => self.book_gone(book_id).await,
            },
        }
    }

    async fn reproject_book_or_gone(&self, book_uid: &str, root: &Path) -> Result<(), AppError> {
        let records: Option<i64> = sqlx::query_scalar("SELECT 1 FROM book_records WHERE uid = ?1")
            .bind(book_uid)
            .fetch_optional(&self.inner.pool)
            .await?;
        let bindings: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM sync_book_bindings WHERE book_uid = ?1 LIMIT 1")
                .bind(book_uid)
                .fetch_optional(&self.inner.pool)
                .await?;
        if records.is_none() && bindings.is_none() {
            return Ok(());
        }
        merge::project_book(&self.inner.pool, book_uid, root, &self.inner.covers_dir).await?;
        Ok(())
    }

    /// A missing file row means the reported condition is gone; nothing to do.
    async fn book_gone(&self, book_id: i64) -> Result<(), AppError> {
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM books WHERE id = ?1")
            .bind(book_id)
            .fetch_optional(&self.inner.pool)
            .await?;
        if exists.is_none() {
            return Ok(());
        }
        Err(AppError::InvalidInput(format!(
            "book {book_id} has no available file to retry"
        )))
    }

    /// Apply a missing cover to the book, not just the cache. The metadata op
    /// that referenced it already applied without the cover, so re-run the
    /// normal cover path from the cached blob. Its triggers publish the new
    /// override on the next pass.
    async fn apply_missing_cover(
        &self,
        name: &str,
        file_name: Option<&str>,
        root: &Path,
    ) -> Result<(), AppError> {
        if !store::apply_cover_blob(root, &self.inner.covers_dir, name)? {
            return Err(AppError::InvalidInput(format!(
                "cover {name} is not in the sync folder yet"
            )));
        }
        let relative = file_name.ok_or_else(|| {
            AppError::InvalidInput("the missing cover has no operation file to read".into())
        })?;
        let op = read_sync_op(root, relative)?;
        let book_uid = op.book_uid.unwrap_or(op.entity_uid);
        let book_id: Option<i64> =
            sqlx::query_scalar("SELECT id FROM books WHERE book_uid = ?1 ORDER BY id LIMIT 1")
                .bind(&book_uid)
                .fetch_optional(&self.inner.pool)
                .await?;
        let book_id = book_id.ok_or_else(|| {
            AppError::InvalidInput("the book for this cover is not in the library".into())
        })?;
        let image = self.inner.covers_dir.join(name);
        let image = image.to_str().ok_or_else(|| {
            AppError::InvalidInput("the cover cache path is not valid UTF-8".into())
        })?;
        crate::services::metadata::set_book_cover(
            &self.inner.pool,
            book_id,
            image,
            &self.inner.covers_dir,
        )
        .await?;
        Ok(())
    }

    async fn issue_is_open(&self, id: i64) -> Result<bool, AppError> {
        let row: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM sync_issues WHERE id = ?1 AND resolved_at IS NULL")
                .bind(id)
                .fetch_optional(&self.inner.pool)
                .await?;
        Ok(row.is_some())
    }

    /// Leave the row open and say the retry did not clear it, once.
    async fn keep_issue_open(&self, id: i64) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE sync_issues
             SET detail = CASE
                     WHEN instr(detail, 'retry did not clear this condition') = 0
                     THEN detail || ' (retry did not clear this condition)'
                     ELSE detail
                 END,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND resolved_at IS NULL",
        )
        .bind(id)
        .execute(&self.inner.pool)
        .await?;
        Ok(())
    }
}

/// Take the value after `prefix` from an issue key.
fn parse_key(issue_key: &str, prefix: &str) -> Result<String, AppError> {
    issue_key
        .strip_prefix(prefix)
        .filter(|rest| !rest.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::InvalidInput(format!("sync issue key {issue_key} cannot be retried"))
        })
}

fn parse_key_i64(issue_key: &str, prefix: &str) -> Result<i64, AppError> {
    parse_key(issue_key, prefix)?.parse::<i64>().map_err(|_| {
        AppError::InvalidInput(format!("sync issue key {issue_key} cannot be retried"))
    })
}
