//! The background sync engine.
//!
//! One pass exports local dirty state, refreshes book identities, applies
//! remote operations, and projects the final mirror into the catalog. Passes
//! are serialized, never block app startup, and report failures through the
//! status/issue tables instead of crashing the sidecar.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::sync::{watch, Notify};

use crate::error::AppError;
use crate::rpc::EventEmitter;
use crate::services::library_reconciler::LibraryChange;

use super::capture;
use super::clock::{
    delete_meta, device_id, get_meta, now_rfc3339, set_meta, META_BASELINE_DONE, META_DEVICE_NAME,
    META_ENABLED, META_FOLDER, META_LAST_ERROR, META_LAST_SYNC, META_LIBRARY_ID,
};
use super::conflict;
use super::identity::{ensure_book_identity, record_issue};
use super::merge::{self, Affected};
use super::model::{canonical_from_snapshot, state_display, EntityKind};
use super::store;
use super::waiting;

const PASS_INTERVAL: Duration = Duration::from_secs(10);
const DIRTY_POLL: Duration = Duration::from_secs(2);
const CAPTURE_BATCH: i64 = 250;
const REMOTE_BATCH: usize = 500;
const IDENTITY_BUDGET: Duration = Duration::from_secs(3);
const FILE_RETRY_LIMIT: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    Disabled,
    Idle,
    Syncing,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub folder: Option<String>,
    pub library_id: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub state: SyncState,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub pending_local: i64,
    pub waiting_books: i64,
    pub issues: i64,
    pub trash: i64,
    pub conflicts: i64,
}

/// What the UI offers on one issue row. The action is computed from the kind
/// here, so the renderer never parses issue keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncIssueAction {
    /// The condition can be repaired now; run the matching retry path.
    Retry,
    /// The repair is outside the app, in the sync folder.
    OpenFolder,
    /// The row is informational; copy its details for a bug report.
    CopyDetails,
    /// The row is informational and has nothing worth copying.
    Dismiss,
}

impl SyncIssueAction {
    pub fn for_kind(kind: &str) -> Self {
        match kind {
            "projection_failed"
            | "identity_failed"
            | "reprojection_failed"
            | "book_lifecycle_failed"
            | "sync_failed"
            | "operation_retrying"
            | "cover_missing"
            | "cover_blob_failed" => Self::Retry,
            // A rejected operation failed the retry limit. The file has to be
            // fixed or removed in the sync folder before another pass helps.
            "operation_rejected" => Self::OpenFolder,
            // An unknown dirty marker is internal state that is cleared as it
            // is reported, so there is nothing for the user to repair.
            "invalid_dirty_kind" => Self::Dismiss,
            _ => Self::CopyDetails,
        }
    }

    /// Informational rows may be dismissed; actionable rows must not be hidden.
    fn is_informational(self) -> bool {
        matches!(self, Self::CopyDetails | Self::Dismiss)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncIssue {
    pub id: i64,
    pub kind: String,
    pub detail: String,
    pub file_name: Option<String>,
    pub action: SyncIssueAction,
    pub target: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTrashEntry {
    pub id: i64,
    pub kind: String,
    pub label: String,
    pub deleted_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMismatch {
    pub local_library_id: String,
    pub remote_library_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConnectResult {
    pub status: SyncStatus,
    pub mismatch: Option<SyncMismatch>,
    /// Set when the user asked to start a new library and the existing one
    /// was moved aside. The old library is preserved at this path.
    pub archived_library_path: Option<String>,
}

struct Inner {
    pool: SqlitePool,
    covers_dir: PathBuf,
    events: EventEmitter,
    status: RwLock<SyncStatus>,
    pass_lock: tokio::sync::Mutex<()>,
    wake: Notify,
    shutdown: watch::Sender<bool>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct SyncService {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for SyncService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncService").finish_non_exhaustive()
    }
}

impl SyncService {
    pub async fn new(
        pool: SqlitePool,
        db_path: &Path,
        events: EventEmitter,
    ) -> Result<Self, AppError> {
        let enabled = get_meta(&pool, META_ENABLED)
            .await?
            .is_some_and(|value| value == "1");
        let status = SyncStatus {
            enabled,
            folder: get_meta(&pool, META_FOLDER).await?,
            library_id: get_meta(&pool, META_LIBRARY_ID).await?,
            device_id: get_meta(&pool, super::clock::META_DEVICE_ID).await?,
            device_name: get_meta(&pool, META_DEVICE_NAME).await?,
            state: if enabled {
                SyncState::Idle
            } else {
                SyncState::Disabled
            },
            last_sync_at: get_meta(&pool, META_LAST_SYNC).await?,
            last_error: non_empty(get_meta(&pool, META_LAST_ERROR).await?),
            pending_local: 0,
            waiting_books: 0,
            issues: 0,
            trash: 0,
            conflicts: 0,
        };
        let (shutdown, _) = watch::channel(false);
        Ok(Self {
            inner: Arc::new(Inner {
                pool,
                covers_dir: crate::covers_dir(db_path),
                events,
                status: RwLock::new(status),
                pass_lock: tokio::sync::Mutex::new(()),
                wake: Notify::new(),
                shutdown,
                task: Mutex::new(None),
            }),
        })
    }

    pub fn start(self: &Arc<Self>) {
        let service = self.clone();
        let mut shutdown = self.inner.shutdown.subscribe();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let mut last_pass = Instant::now() - PASS_INTERVAL;
            loop {
                let woken = tokio::select! {
                    changed = shutdown.changed() => {
                        let _ = changed;
                        break;
                    }
                    _ = service.inner.wake.notified() => true,
                    _ = tokio::time::sleep(DIRTY_POLL) => false,
                };
                if !service.status_snapshot().enabled {
                    continue;
                }
                let dirty: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty")
                    .fetch_one(&service.inner.pool)
                    .await
                    .unwrap_or(0);
                if woken || dirty > 0 || last_pass.elapsed() >= PASS_INTERVAL {
                    let _ = service.run_pass().await;
                    last_pass = Instant::now();
                }
            }
        });
        *self
            .inner
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(task);
    }

    /// Flush once with a deadline, then stop the loop. Called from `serve` on
    /// stdin EOF so the last reading position reaches the folder.
    pub async fn shutdown(&self) {
        if self.status_snapshot().enabled {
            let _ = tokio::time::timeout(Duration::from_secs(3), self.run_pass()).await;
        }
        let _ = self.inner.shutdown.send(true);
        let task = self
            .inner
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(task) = task {
            let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
        }
    }

    pub fn wake(&self) {
        self.inner.wake.notify_one();
    }

    pub async fn sync_now(&self) -> Result<SyncStatus, AppError> {
        self.wake();
        self.status().await
    }

    pub async fn status(&self) -> Result<SyncStatus, AppError> {
        self.refresh_status().await?;
        Ok(self.status_snapshot())
    }

    pub async fn waiting_books(&self) -> Result<Vec<waiting::WaitingBook>, AppError> {
        waiting::list(&self.inner.pool).await
    }

    pub async fn forget_waiting_book(&self, book_uid: &str) -> Result<bool, AppError> {
        let ignored = waiting::forget(&self.inner.pool, book_uid).await?;
        if ignored {
            self.refresh_status().await?;
        }
        Ok(ignored)
    }

    pub async fn forget_all_waiting_books(&self) -> Result<usize, AppError> {
        let ignored = waiting::forget_all(&self.inner.pool).await?;
        if ignored > 0 {
            self.refresh_status().await?;
        }
        Ok(ignored)
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

    fn status_snapshot(&self) -> SyncStatus {
        self.inner
            .status
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_state(&self, state: SyncState) {
        let mut status = self
            .inner
            .status
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.state = state;
    }

    async fn refresh_status(&self) -> Result<(), AppError> {
        let pool = &self.inner.pool;
        // Settle conflicts whose winner has moved and expire unread rows first,
        // so the count, the list, and the open issues always agree. Both are
        // best effort: a busy database must not fail a status read.
        if let Err(err) = conflict::reconcile(pool).await {
            eprintln!("sync review: reconcile failed: {err}");
        }
        if let Err(err) = conflict::expire(pool).await {
            eprintln!("sync review: expiry failed: {err}");
        }
        // Close rows whose condition is gone before counting, so the count,
        // the list, and the open rows always agree. Best effort, like the
        // conflict reconcile above.
        if let Err(err) = self.resolve_cleared_issues().await {
            eprintln!("sync issues: auto-resolve failed: {err}");
        }
        let pending_local: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty")
            .fetch_one(pool)
            .await?;
        // Conflicts live in the Conflict review section, which has its own
        // count. Listing them here would offer a Dismiss button that hides a
        // conflict without settling it.
        let issues: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_issues
             WHERE resolved_at IS NULL AND kind <> 'conflict'",
        )
        .fetch_one(pool)
        .await?;
        let trash: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_trash
             WHERE restored_at IS NULL AND expires_at > ?1",
        )
        .bind(now_rfc3339())
        .fetch_one(pool)
        .await?;
        let conflicts: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_conflicts
             WHERE resolved_at IS NULL AND kind <> 'progress'",
        )
        .fetch_one(pool)
        .await?;
        let waiting_books = waiting::count(pool).await?;
        let enabled = get_meta(pool, META_ENABLED)
            .await?
            .is_some_and(|value| value == "1");
        let last_error = non_empty(get_meta(pool, META_LAST_ERROR).await?);
        let last_sync_at = get_meta(pool, META_LAST_SYNC).await?;
        let folder = get_meta(pool, META_FOLDER).await?;
        let library_id = get_meta(pool, META_LIBRARY_ID).await?;
        let device_id = get_meta(pool, super::clock::META_DEVICE_ID).await?;
        let device_name = get_meta(pool, META_DEVICE_NAME).await?;

        let mut status = self
            .inner
            .status
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status.enabled = enabled;
        status.folder = folder;
        status.library_id = library_id;
        status.device_id = device_id;
        status.device_name = device_name;
        status.last_sync_at = last_sync_at;
        status.last_error = last_error.clone();
        status.pending_local = pending_local;
        status.waiting_books = waiting_books;
        status.issues = issues;
        status.trash = trash;
        status.conflicts = conflicts;
        status.state = if !enabled {
            SyncState::Disabled
        } else if status.state == SyncState::Syncing {
            SyncState::Syncing
        } else if last_error.is_some() {
            SyncState::Error
        } else {
            SyncState::Idle
        };
        Ok(())
    }

    async fn remember_error(&self, detail: &str) {
        let _ = set_meta(&self.inner.pool, META_LAST_ERROR, detail).await;
        self.set_state(SyncState::Error);
    }

    async fn clear_error(&self) {
        let _ = delete_meta(&self.inner.pool, META_LAST_ERROR).await;
        let _ = sqlx::query(
            "UPDATE sync_issues SET resolved_at = ?1
             WHERE issue_key = 'sync-pass' AND resolved_at IS NULL",
        )
        .bind(now_rfc3339())
        .execute(&self.inner.pool)
        .await;
    }

    pub async fn run_pass(&self) -> Result<(), AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        self.run_pass_locked().await
    }

    /// Take the pass once. The caller must already hold `pass_lock`.
    async fn run_pass_locked(&self) -> Result<(), AppError> {
        let result = self.pass_locked().await;
        match result {
            Ok(()) => {
                self.clear_error().await;
                let _ = self.refresh_status().await;
                self.set_state(if self.status_snapshot().enabled {
                    SyncState::Idle
                } else {
                    SyncState::Disabled
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
                self.set_state(SyncState::Error);
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
        let Some(folder) = status.folder else {
            return Ok(());
        };
        self.set_state(SyncState::Syncing);
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

    async fn identity_sweep(&self, root: &Path) -> Result<usize, AppError> {
        let deadline = Instant::now() + IDENTITY_BUDGET;
        let mut last_id = 0i64;
        let mut bound = 0usize;
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
                            if changed {
                                bound += 1;
                            }
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
        Ok(bound)
    }

    async fn sync_remote(&self, root: &Path) -> Result<(), AppError> {
        let files = store::scan_ops(root)?;
        let mut affected: Vec<Affected> = Vec::new();
        let mut identity_books: Vec<String> = Vec::new();
        let mut mark_processed: Vec<(String, i64, i64)> = Vec::new();
        let mut processed = 0usize;

        for file in files {
            let cached: Option<(i64, i64, Option<String>, i64)> = sqlx::query_as(
                "SELECT size, mtime, processed_at, failures FROM sync_remote_files
                 WHERE relative_path = ?1",
            )
            .bind(&file.relative_path)
            .fetch_optional(&self.inner.pool)
            .await?;
            if let Some((size, mtime, processed_at, _)) = cached {
                if size == file.size && mtime == file.mtime && processed_at.is_some() {
                    continue;
                }
            }
            if processed >= REMOTE_BATCH {
                break;
            }

            let mut op = match store::read_op(&file.path) {
                Ok(op) => op,
                Err(err) => {
                    self.record_file_failure(&file, &err).await?;
                    processed += 1;
                    continue;
                }
            };

            if op.kind == EntityKind::Metadata && !op.deleted {
                if let Some(name) = op.fields.get("cover_path").and_then(Value::as_str) {
                    match store::apply_cover_blob(root, &self.inner.covers_dir, name) {
                        Ok(true) => {}
                        Ok(false) => {
                            record_issue(
                                &self.inner.pool,
                                &format!("cover-missing:{name}"),
                                "cover_missing",
                                &format!(
                                    "cover {name} is not in the sync folder yet; \
                                     applying the metadata edit without it"
                                ),
                                Some(&file.relative_path),
                            )
                            .await?;
                            op.fields.insert("cover_path".into(), Value::Null);
                        }
                        Err(err) => {
                            record_issue(
                                &self.inner.pool,
                                &format!("cover-missing:{name}"),
                                "cover_missing",
                                &format!("could not read cover {name}: {err}"),
                                Some(&file.relative_path),
                            )
                            .await?;
                            op.fields.insert("cover_path".into(), Value::Null);
                        }
                    }
                }
            }

            let mut applied = merge::apply_op(&self.inner.pool, &op, &file.relative_path).await?;
            if op.kind == EntityKind::BookIdentity {
                let canonical =
                    super::identity::canonical_book_uid(&self.inner.pool, &op.entity_uid).await?;
                identity_books.push(canonical);
            }
            if applied.is_empty() {
                applied.push(Affected {
                    kind: op.kind,
                    entity_uid: op.entity_uid.clone(),
                    book_uid: op.book_uid.clone(),
                });
            }
            affected.extend(applied);
            mark_processed.push((file.relative_path.clone(), file.size, file.mtime));
            processed += 1;
        }

        let mut books = if affected.is_empty() {
            Vec::new()
        } else {
            merge::project(&self.inner.pool, root, &self.inner.covers_dir, &affected).await?
        };
        identity_books.sort();
        identity_books.dedup();
        for book_uid in identity_books {
            if let Ok(mut projected) =
                merge::project_book(&self.inner.pool, &book_uid, root, &self.inner.covers_dir).await
            {
                books.append(&mut projected);
            }
        }
        if !books.is_empty() {
            books.sort_unstable();
            books.dedup();
            self.emit_changes(&books).await;
        }
        for (relative, size, mtime) in mark_processed {
            sqlx::query(
                r#"
                INSERT INTO sync_remote_files (relative_path, size, mtime, failures, processed_at)
                VALUES (?1, ?2, ?3, 0, ?4)
                ON CONFLICT(relative_path) DO UPDATE SET
                    size = excluded.size,
                    mtime = excluded.mtime,
                    failures = 0,
                    processed_at = excluded.processed_at
                "#,
            )
            .bind(relative)
            .bind(size)
            .bind(mtime)
            .bind(now_rfc3339())
            .execute(&self.inner.pool)
            .await?;
        }
        Ok(())
    }

    /// Deleting the canonical local row of a shared book queues its uuid. If
    /// another bound row remains, project the shared state onto it so a
    /// duplicate copy does not look empty after the first copy is removed.
    async fn reproject_queued(&self, root: &Path) -> Result<(), AppError> {
        let uids: Vec<String> = sqlx::query_scalar(
            "SELECT book_uid FROM sync_reproject ORDER BY requested_at, book_uid LIMIT 25",
        )
        .fetch_all(&self.inner.pool)
        .await?;
        let mut books = Vec::new();
        for book_uid in uids {
            let has_binding: Option<i64> =
                sqlx::query_scalar("SELECT 1 FROM sync_book_bindings WHERE book_uid = ?1 LIMIT 1")
                    .bind(&book_uid)
                    .fetch_optional(&self.inner.pool)
                    .await?;
            if has_binding.is_some() {
                match merge::project_book(&self.inner.pool, &book_uid, root, &self.inner.covers_dir)
                    .await
                {
                    Ok(mut projected) => {
                        books.append(&mut projected);
                        resolve_issue_key(&self.inner.pool, &format!("reproject:{book_uid}"))
                            .await?;
                    }
                    Err(err) => {
                        record_issue(
                            &self.inner.pool,
                            &format!("reproject:{book_uid}"),
                            "reprojection_failed",
                            &format!("could not project state for {book_uid}: {err}"),
                            None,
                        )
                        .await?;
                        continue;
                    }
                }
            } else {
                // No copy is bound any more, so there is nothing left to
                // reproject and the reported condition is gone.
                resolve_issue_key(&self.inner.pool, &format!("reproject:{book_uid}")).await?;
            }
            sqlx::query(
                "UPDATE sync_issues SET resolved_at = ?2
                 WHERE issue_key LIKE ?1 AND resolved_at IS NULL",
            )
            .bind(format!("duplicate-book:{book_uid}:%"))
            .bind(now_rfc3339())
            .execute(&self.inner.pool)
            .await?;
            super::identity::record_duplicate_bindings(&self.inner.pool, &book_uid).await?;
            sqlx::query("DELETE FROM sync_reproject WHERE book_uid = ?1")
                .bind(&book_uid)
                .execute(&self.inner.pool)
                .await?;
        }
        books.sort_unstable();
        books.dedup();
        if !books.is_empty() {
            self.emit_changes(&books).await;
        }
        Ok(())
    }

    async fn record_file_failure(
        &self,
        file: &store::RemoteFile,
        detail: &str,
    ) -> Result<(), AppError> {
        let cached: Option<(i64, i64, i64)> = sqlx::query_as(
            "SELECT size, mtime, failures FROM sync_remote_files WHERE relative_path = ?1",
        )
        .bind(&file.relative_path)
        .fetch_optional(&self.inner.pool)
        .await?;
        let failures = match cached {
            Some((size, mtime, failures)) if size == file.size && mtime == file.mtime => {
                failures + 1
            }
            _ => 1,
        };
        let give_up = failures >= FILE_RETRY_LIMIT;
        sqlx::query(
            r#"
            INSERT INTO sync_remote_files (relative_path, size, mtime, failures, processed_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(relative_path) DO UPDATE SET
                size = excluded.size,
                mtime = excluded.mtime,
                failures = excluded.failures,
                processed_at = excluded.processed_at
            "#,
        )
        .bind(&file.relative_path)
        .bind(file.size)
        .bind(file.mtime)
        .bind(failures)
        .bind(if give_up { Some(now_rfc3339()) } else { None })
        .execute(&self.inner.pool)
        .await?;
        record_issue(
            &self.inner.pool,
            &format!("file:{}", file.relative_path),
            if give_up {
                "operation_rejected"
            } else {
                "operation_retrying"
            },
            if give_up {
                format!("gave up after {failures} attempts: {detail}")
            } else {
                format!("attempt {failures}: {detail}")
            }
            .as_str(),
            Some(&file.relative_path),
        )
        .await
    }

    async fn emit_changes(&self, books: &[i64]) {
        for book_id in books {
            if let Ok(Some(book)) =
                crate::repository::books::get_book(&self.inner.pool, *book_id).await
            {
                self.inner.events.emit(
                    "library-changed",
                    &LibraryChange::Changed {
                        book: Box::new(book),
                    },
                );
            }
        }
        if !books.is_empty() {
            self.inner
                .events
                .emit("sync-applied", &json!({ "bookIds": books }));
        }
    }

    fn emit_status(&self) {
        let status = self.status_snapshot();
        self.inner.events.emit("sync-status", &status);
    }

    pub async fn connect(
        &self,
        folder: &str,
        device_name: Option<String>,
        confirm_library_id: Option<String>,
        start_new: bool,
    ) -> Result<SyncConnectResult, AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        let path = Path::new(folder);
        if !path.is_absolute() {
            return Err(AppError::InvalidInput(
                "sync folder must be an absolute path".into(),
            ));
        }
        let name = device_name
            .or_else(|| self.status_snapshot().device_name)
            .unwrap_or_else(default_device_name);
        let name = validate_device_name(&name)?;
        let id = device_id(&self.inner.pool).await?;
        let now = now_rfc3339();
        let archived = if start_new {
            store::archive_existing_library(path, &now)?
        } else {
            None
        };
        let info = store::connect(path, &id, &name, &now)?;
        let local_library = get_meta(&self.inner.pool, META_LIBRARY_ID).await?;
        let archived_library_path = archived.map(|path| path.to_string_lossy().into_owned());
        if let Some(local) = &local_library {
            if local != &info.library.library_id {
                // A library this connect just created is ours to adopt. Only a
                // library that already existed can belong to another machine.
                if info.existed
                    && confirm_library_id.as_deref() != Some(info.library.library_id.as_str())
                {
                    self.refresh_status().await?;
                    return Ok(SyncConnectResult {
                        status: self.status_snapshot(),
                        mismatch: Some(SyncMismatch {
                            local_library_id: local.clone(),
                            remote_library_id: info.library.library_id.clone(),
                        }),
                        archived_library_path: None,
                    });
                }
                self.reset_sync_state().await?;
            }
        }

        let folder_display = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .into_owned();
        set_meta(&self.inner.pool, META_LIBRARY_ID, &info.library.library_id).await?;
        set_meta(&self.inner.pool, META_FOLDER, &folder_display).await?;
        set_meta(&self.inner.pool, META_DEVICE_NAME, &name).await?;
        set_meta(&self.inner.pool, META_ENABLED, "1").await?;
        if local_library.is_none()
            || get_meta(&self.inner.pool, META_BASELINE_DONE)
                .await?
                .as_deref()
                != Some("1")
        {
            set_meta(&self.inner.pool, META_BASELINE_DONE, "0").await?;
        }
        self.clear_error().await;
        self.refresh_status().await?;
        self.wake();
        Ok(SyncConnectResult {
            status: self.status_snapshot(),
            mismatch: None,
            archived_library_path,
        })
    }

    async fn reset_sync_state(&self) -> Result<(), AppError> {
        let mut tx = self.inner.pool.begin().await?;
        for table in [
            "sync_state_fields",
            "sync_state_entities",
            "sync_book_aliases",
            "sync_book_bindings",
            "sync_book_merges",
            "sync_entity_merges",
            "sync_ops",
            "sync_applied_ops",
            "sync_remote_files",
            "sync_issues",
            "sync_conflicts",
            "sync_trash",
            "sync_book_trash",
            "sync_dirty",
            "sync_reproject",
        ] {
            sqlx::query(&format!("DELETE FROM {table}"))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        set_meta(&self.inner.pool, META_BASELINE_DONE, "0").await?;
        Ok(())
    }

    pub async fn disconnect(&self) -> Result<SyncStatus, AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        set_meta(&self.inner.pool, META_ENABLED, "0").await?;
        self.clear_error().await;
        self.refresh_status().await?;
        self.set_state(SyncState::Disabled);
        self.emit_status();
        Ok(self.status_snapshot())
    }

    pub async fn set_device_name(&self, name: &str) -> Result<SyncStatus, AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        let name = validate_device_name(name)?;
        set_meta(&self.inner.pool, META_DEVICE_NAME, &name).await?;
        if let Some(folder) = self.status_snapshot().folder {
            let id = device_id(&self.inner.pool).await?;
            let _ = store::connect(Path::new(&folder), &id, &name, &now_rfc3339());
        }
        self.refresh_status().await?;
        self.emit_status();
        Ok(self.status_snapshot())
    }

    pub async fn issues(&self) -> Result<Vec<SyncIssue>, AppError> {
        type Row = (i64, String, String, String, Option<String>, String, String);
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, issue_key, kind, detail, file_name, created_at, updated_at
                 FROM sync_issues
                 WHERE resolved_at IS NULL AND kind <> 'conflict'
                 ORDER BY updated_at DESC, id DESC LIMIT 100",
        )
        .fetch_all(&self.inner.pool)
        .await?;
        let mut issues = Vec::with_capacity(rows.len());
        for (id, issue_key, kind, detail, file_name, created_at, updated_at) in rows {
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
        // Review owns conflicts. Dismissing one would hide it without settling it.
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
        let outcome = self
            .retry_locked(&kind, &issue_key, file_name.as_deref())
            .await;
        match outcome {
            Ok(cleared) => {
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

    /// Run the retry path for one kind. The caller holds `pass_lock`. Returns
    /// true when the work itself proves the condition is gone.
    async fn retry_locked(
        &self,
        kind: &str,
        issue_key: &str,
        file_name: Option<&str>,
    ) -> Result<bool, AppError> {
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
    async fn resolve_cleared_issues(&self) -> Result<u64, AppError> {
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

    async fn book_record_exists(&self, book_uid: &str) -> Result<bool, AppError> {
        let row: Option<i64> = sqlx::query_scalar("SELECT 1 FROM book_records WHERE uid = ?1")
            .bind(book_uid)
            .fetch_optional(&self.inner.pool)
            .await?;
        Ok(row.is_some())
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

    /// A file is done when its current cache row says it applied cleanly, or
    /// when it is gone. A stale applied-op row from an earlier version of the
    /// same path does not count.
    async fn operation_cleared(
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

    pub async fn trash(&self) -> Result<Vec<SyncTrashEntry>, AppError> {
        let rows: Vec<(i64, String, String, String, String)> = sqlx::query_as(
            "SELECT id, kind, prior_json, deleted_at, expires_at FROM sync_trash
             WHERE restored_at IS NULL AND expires_at > ?1
             ORDER BY deleted_at DESC, id DESC LIMIT 100",
        )
        .bind(now_rfc3339())
        .fetch_all(&self.inner.pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, kind, prior_json, deleted_at, expires_at)| {
                let kind = EntityKind::parse(&kind)?;
                let prior: serde_json::Map<String, Value> =
                    serde_json::from_str(&prior_json).ok()?;
                let state = canonical_from_snapshot(kind, &prior);
                Some(SyncTrashEntry {
                    id,
                    kind: kind.as_str().to_string(),
                    label: state_display(kind, &state),
                    deleted_at,
                    expires_at,
                })
            })
            .collect())
    }

    pub async fn restore(&self, trash_id: i64) -> Result<bool, AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        let row: Option<(String, String, Option<String>, String)> = sqlx::query_as(
            "SELECT kind, entity_uid, book_uid, prior_json FROM sync_trash
             WHERE id = ?1 AND restored_at IS NULL AND expires_at > ?2",
        )
        .bind(trash_id)
        .bind(now_rfc3339())
        .fetch_optional(&self.inner.pool)
        .await?;
        let Some((kind, entity_uid, book_uid, prior_json)) = row else {
            return Ok(false);
        };
        let Some(kind) = EntityKind::parse(&kind) else {
            return Ok(false);
        };
        let prior: serde_json::Map<String, Value> = serde_json::from_str(&prior_json)
            .map_err(|err| AppError::InvalidInput(format!("trash entry is not readable: {err}")))?;
        let Some(folder) = self.status_snapshot().folder else {
            return Err(AppError::InvalidInput("sync is not connected".into()));
        };
        let root = store::resolve_root(Path::new(&folder))?;
        capture::write_restore(
            &self.inner.pool,
            &root,
            kind,
            &entity_uid,
            book_uid.as_deref(),
            &prior,
        )
        .await?;
        sqlx::query("UPDATE sync_trash SET restored_at = ?2 WHERE id = ?1")
            .bind(trash_id)
            .bind(now_rfc3339())
            .execute(&self.inner.pool)
            .await?;
        let affected = vec![Affected {
            kind,
            entity_uid,
            book_uid,
        }];
        let books =
            merge::project(&self.inner.pool, &root, &self.inner.covers_dir, &affected).await?;
        self.emit_changes(&books).await;
        self.refresh_status().await?;
        self.emit_status();
        Ok(true)
    }

    fn sync_root(&self) -> Option<PathBuf> {
        let folder = self.status_snapshot().folder?;
        store::resolve_root(Path::new(&folder)).ok()
    }

    /// Open, unexpired conflicts newest first, with the values, device names,
    /// and clocks the review UI needs.
    pub async fn list_conflicts(&self) -> Result<Vec<conflict::SyncConflict>, AppError> {
        self.refresh_status().await?;
        let root = self.sync_root();
        conflict::list(&self.inner.pool, root.as_deref()).await
    }

    /// Settle one conflict. `keep_winner` leaves the applied state alone;
    /// `apply_loser` publishes the losing value as a fresh synced write so
    /// every device converges on it.
    pub async fn resolve_conflict(&self, id: i64, resolution: &str) -> Result<bool, AppError> {
        let Some(resolution) = conflict::Resolution::parse(resolution) else {
            return Err(AppError::InvalidInput(format!(
                "unknown conflict resolution {resolution:?}"
            )));
        };
        let _guard = self.inner.pass_lock.lock().await;
        conflict::expire(&self.inner.pool).await?;
        let Some(open) = conflict::open(&self.inner.pool, id).await? else {
            return Ok(false);
        };
        let mut books = Vec::new();
        let mut applied = false;
        if resolution == conflict::Resolution::ApplyLoser {
            if let Some(reason) = conflict::apply_blocked_reason(open.kind, &open.field) {
                return Err(AppError::InvalidInput(reason.into()));
            }
            let Some(folder) = self.status_snapshot().folder else {
                return Err(AppError::InvalidInput(
                    "sync is not connected; re-apply the value from its original screen".into(),
                ));
            };
            let root = store::resolve_root(Path::new(&folder))?;
            let affected = conflict::apply_loser(&self.inner.pool, &root, &open).await?;
            books = merge::project(
                &self.inner.pool,
                &root,
                &self.inner.covers_dir,
                std::slice::from_ref(&affected),
            )
            .await?;
            applied = true;
        }
        let settled = conflict::settle(&self.inner.pool, id, &open).await?;
        self.emit_changes(&books).await;
        self.refresh_status().await?;
        self.emit_status();
        Ok(applied || settled)
    }
}

/// True when an issue with this internal key is still open.
async fn issue_key_open(pool: &SqlitePool, issue_key: &str) -> Result<bool, AppError> {
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sync_issues WHERE issue_key = ?1 AND resolved_at IS NULL LIMIT 1",
    )
    .bind(issue_key)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Close one issue by its internal key. Used by natural repair paths.
async fn resolve_issue_key(pool: &SqlitePool, issue_key: &str) -> Result<(), AppError> {
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
fn read_sync_op(root: &Path, relative: &str) -> Result<super::model::Op, AppError> {
    let path = safe_sync_path(root, relative).ok_or_else(|| {
        AppError::InvalidInput("the operation path in this issue is not safe to read".into())
    })?;
    store::read_op(&path)
        .map_err(|err| AppError::InvalidInput(format!("the operation file is not readable: {err}")))
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

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn default_device_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "TuxBooks".to_string())
}

fn validate_device_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("device name is empty".into()));
    }
    if name.chars().count() > 80 {
        return Err(AppError::InvalidInput("device name is too long".into()));
    }
    Ok(name.to_string())
}
