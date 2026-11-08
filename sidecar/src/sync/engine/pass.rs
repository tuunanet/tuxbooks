//! One sync pass: serialize under the pass lock, then capture, apply, project.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::error::AppError;

use super::clear::{issue_key_open, resolve_issue_key};
use super::default_device_name;
use crate::sync::capture;
use crate::sync::clock::{
    device_id, get_meta, now_rfc3339, set_meta, META_BASELINE_DONE, META_LAST_SYNC, META_LIBRARY_ID,
};
use crate::sync::identity::{ensure_book_identity, record_issue};
use crate::sync::merge;
use crate::sync::store;

const CAPTURE_BATCH: i64 = 250;
const IDENTITY_BUDGET: Duration = Duration::from_secs(3);

impl super::SyncService {
    pub async fn run_pass(&self) -> Result<(), AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        let result = self.run_pass_locked().await;
        // The sweep reuses this call's lock (ADR 0017 D4). It runs after a
        // failed pass too: its own backoff governs how often its retries
        // burn, and the rows it retries may not be the ones this pass
        // reported.
        self.auto_retry_sweep().await;
        result
    }

    /// Take the pass once. The caller must already hold `pass_lock`.
    pub(super) async fn run_pass_locked(&self) -> Result<(), AppError> {
        let result = self.pass_locked().await;
        match result {
            Ok(()) => {
                self.clear_error().await;
                let _ = self.refresh_status().await;
                self.set_state(if self.status_snapshot().enabled {
                    super::SyncState::Idle
                } else {
                    super::SyncState::Disabled
                });
                self.emit_status();
                Ok(())
            }
            Err(err) => {
                self.remember_error(&err.to_string()).await;
                let _ = record_issue(
                    &self.inner.pool,
                    "sync-pass",
                    "sync_failed",
                    &err.to_string(),
                    None,
                )
                .await;
                let _ = self.refresh_status().await;
                self.set_state(super::SyncState::Error);
                self.emit_status();
                Err(err)
            }
        }
    }

    async fn pass_locked(&self) -> Result<(), AppError> {
        self.refresh_status().await?;
        let status = self.status_snapshot();
        if !status.enabled {
            return Ok(());
        }
        self.flush_library_reload().await?;
        let Some(folder) = status.folder else {
            return Ok(());
        };
        self.set_state(super::SyncState::Syncing);
        self.emit_status();

        let root = store::resolve_root(Path::new(&folder))?;
        if !root.join("library.json").exists() {
            return Err(AppError::InvalidInput(format!(
                "sync folder {} is missing library.json",
                root.display()
            )));
        }
        let device_id = device_id(&self.inner.pool).await?;
        let device_name = self
            .status_snapshot()
            .device_name
            .unwrap_or_else(default_device_name);
        let info = store::connect(Path::new(&folder), &device_id, &device_name, &now_rfc3339())?;
        let library_id = get_meta(&self.inner.pool, META_LIBRARY_ID).await?;
        if library_id.as_deref() != Some(info.library.library_id.as_str()) {
            return Err(AppError::InvalidInput(
                "sync folder belongs to a different library; reconnect to confirm".into(),
            ));
        }

        self.baseline_if_needed().await?;
        self.identity_sweep(&root).await?;

        let report = capture::drain(
            &self.inner.pool,
            &root,
            &self.inner.covers_dir,
            CAPTURE_BATCH,
        )
        .await?;
        if report.pending_identity > 0 {
            self.identity_sweep(&root).await?;
        }

        self.sync_remote(&root).await?;
        self.reproject_queued(&root).await?;

        // Projection writes local rows, which fire the same triggers; drain
        // the echo markers so the next pass starts clean.
        let _ = capture::drain(
            &self.inner.pool,
            &root,
            &self.inner.covers_dir,
            CAPTURE_BATCH,
        )
        .await;

        self.flush_library_reload().await?;
        set_meta(&self.inner.pool, META_LAST_SYNC, &now_rfc3339()).await?;
        Ok(())
    }

    async fn baseline_if_needed(&self) -> Result<(), AppError> {
        if get_meta(&self.inner.pool, META_BASELINE_DONE)
            .await?
            .as_deref()
            == Some("1")
        {
            return Ok(());
        }
        let mut tx = self.inner.pool.begin().await?;
        // Touching each row fires the same AFTER UPDATE triggers that capture
        // ordinary edits, so the baseline cannot drift from the live rules.
        sqlx::query("UPDATE annotations SET sync_uid = sync_uid")
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE collections SET name = name")
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE reading_progress SET updated_at = updated_at")
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE book_metadata_overrides SET book_uid = book_uid")
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            r#"
            INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
            SELECT 'opened', uid, 'upsert', NULL,
                   json_object('last_opened_at', last_opened_at)
            FROM book_records WHERE last_opened_at IS NOT NULL
            ON CONFLICT(kind, entity_key) DO NOTHING
            "#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
            SELECT 'membership',
                   bc.book_uid || ':' || CAST(bc.collection_id AS TEXT),
                   'upsert', NULL,
                   json_object(
                       'book_uid', bc.book_uid,
                       'collection_id', bc.collection_id,
                       'present', json('true'),
                       'added_at', bc.added_at
                   )
            FROM book_collections bc
            WHERE EXISTS (SELECT 1 FROM book_records br WHERE br.uid = bc.book_uid)
              AND EXISTS (SELECT 1 FROM collections c WHERE c.id = bc.collection_id)
            ON CONFLICT(kind, entity_key) DO NOTHING
            "#,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        set_meta(&self.inner.pool, META_BASELINE_DONE, "1").await?;
        Ok(())
    }

    async fn identity_sweep(&self, root: &Path) -> Result<(), AppError> {
        let deadline = Instant::now() + IDENTITY_BUDGET;
        let mut last_id = 0i64;
        loop {
            if Instant::now() >= deadline {
                break;
            }
            type IdentityCandidate = (i64, Option<String>, Option<i64>, Option<i64>);
            let rows: Vec<IdentityCandidate> = sqlx::query_as(
                r#"
                SELECT b.id, s.content_hash, s.hashed_size, s.hashed_mtime
                FROM books b
                LEFT JOIN sync_book_bindings s ON s.book_id = b.id
                WHERE b.id > ?1 AND b.available = 1
                  AND (b.rehash_pending = 1
                       OR s.book_id IS NULL
                       OR s.hashed_size != b.file_size
                       OR s.hashed_mtime != b.file_mtime
                       OR EXISTS (
                           SELECT 1 FROM sync_issues i
                           WHERE i.issue_key = 'project-book:' || b.id
                             AND i.resolved_at IS NULL
                       ))
                ORDER BY b.id
                LIMIT 25
                "#,
            )
            .bind(last_id)
            .fetch_all(&self.inner.pool)
            .await?;
            if rows.is_empty() {
                break;
            }
            for (book_id, before_hash, _, _) in rows {
                last_id = book_id;
                match ensure_book_identity(&self.inner.pool, book_id).await {
                    Ok(Some(identity)) => {
                        // The identity condition is cleared as soon as hashing
                        // and binding succeed, whether or not the hash moved.
                        resolve_issue_key(&self.inner.pool, &format!("identity:{book_id}")).await?;
                        let changed =
                            before_hash.as_deref() != Some(identity.content_hash.as_str());
                        let needs_projection = changed
                            || issue_key_open(&self.inner.pool, &format!("project-book:{book_id}"))
                                .await?;
                        if needs_projection {
                            match merge::project_book(
                                &self.inner.pool,
                                &identity.book_uid,
                                root,
                                &self.inner.covers_dir,
                            )
                            .await
                            {
                                Ok(_) => {
                                    resolve_issue_key(
                                        &self.inner.pool,
                                        &format!("project-book:{book_id}"),
                                    )
                                    .await?;
                                }
                                Err(err) => {
                                    record_issue(
                                        &self.inner.pool,
                                        &format!("project-book:{book_id}"),
                                        "projection_failed",
                                        &format!(
                                            "could not project state for book {book_id}: {err}"
                                        ),
                                        None,
                                    )
                                    .await?;
                                }
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(err) => {
                        record_issue(
                            &self.inner.pool,
                            &format!("identity:{book_id}"),
                            "identity_failed",
                            &format!("could not hash book {book_id}: {err}"),
                            None,
                        )
                        .await?;
                    }
                }
                if Instant::now() >= deadline {
                    break;
                }
            }
        }
        Ok(())
    }
}
