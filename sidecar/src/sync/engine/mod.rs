//! The background sync engine.
//!
//! One pass exports local dirty state, refreshes book identities, applies
//! remote operations, and projects the final mirror into the catalog. Passes
//! are serialized, never block app startup, and report failures through the
//! status/issue tables instead of crashing the sidecar.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use serde::Serialize;
use serde_json::json;
use sqlx::SqlitePool;
use tokio::sync::{watch, Notify};

use crate::error::AppError;
use crate::rpc::EventEmitter;
use crate::services::library_reconciler::LibraryChange;

use super::clock::{
    delete_meta, get_meta, now_rfc3339, set_meta, META_DEVICE_NAME, META_ENABLED, META_FOLDER,
    META_LAST_ERROR, META_LAST_SYNC, META_LIBRARY_ID, META_LIBRARY_RELOAD,
};
use super::conflict;
use super::store;
use super::waiting;

mod adopt;
mod attach;
mod autoretry;
mod clear;
mod connect;
mod deferred;
mod issues;
mod lifecycle;
mod pass;
mod remote;
mod retry;
mod trash;
mod watcher;

pub use deferred::MISSING_BLOB_ISSUE_THRESHOLD;

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
            | "cover_blob_failed"
            | "hash_failed" => Self::Retry,
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
    /// Automatic retry attempts spent so far against the per-kind cap
    /// (ADR 0017 D4). Report only: attention semantics stay untouched.
    pub auto_attempts: i64,
    /// When the sweep will try this row again; None means due now, or given
    /// up after exhausting the cap.
    pub next_auto_retry_at: Option<String>,
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
    wake: Arc<Notify>,
    shutdown: watch::Sender<bool>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The sync-folder watcher (ADR 0018 D5), alive exactly as long as the
    /// engine: started when sync starts or a folder connects, stopped at
    /// shutdown and disconnect.
    watcher: Mutex<Option<watcher::SyncFolderWatcher>>,
    /// Books whose reader session is open on this device (ADR 0018 D5):
    /// adoption defers for these until the session closes. In-memory only;
    /// the lifetime reasoning lives in `deferred`.
    deferred_books: Mutex<HashSet<String>>,
    /// Consecutive missing-blob passes per book uid, so the silent
    /// op-before-blob wait (ADR 0018 D2) eventually surfaces. In-memory
    /// only; see `deferred`.
    missing_blobs: Mutex<HashMap<String, deferred::MissingBlobPasses>>,
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
        };
        let (shutdown, _) = watch::channel(false);
        Ok(Self {
            inner: Arc::new(Inner {
                pool,
                covers_dir: crate::covers_dir(db_path),
                events,
                status: RwLock::new(status),
                pass_lock: tokio::sync::Mutex::new(()),
                wake: Arc::new(Notify::new()),
                shutdown,
                task: Mutex::new(None),
                watcher: Mutex::new(None),
                deferred_books: Mutex::new(HashSet::new()),
                missing_blobs: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub async fn sync_now(&self) -> Result<SyncStatus, AppError> {
        self.wake();
        self.status().await
    }

    pub async fn status(&self) -> Result<SyncStatus, AppError> {
        self.refresh_status().await?;
        Ok(self.status_snapshot())
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
        // Retire the legacy diagnostics: close conflict rows whose winner has
        // moved and expire rows past the 30-day window, closing the paired
        // legacy issues. Best effort: a busy database must not fail a status
        // read.
        if let Err(err) = conflict::reconcile(pool).await {
            eprintln!("sync diagnostics: reconcile failed: {err}");
        }
        if let Err(err) = conflict::expire(pool).await {
            eprintln!("sync diagnostics: expiry failed: {err}");
        }
        // Close rows whose condition is gone before counting, so the count,
        // the list, and the open rows always agree. Best effort, like the
        // conflict reconcile above.
        if let Err(err) = self.resolve_cleared_issues().await {
            eprintln!("sync issues: auto-resolve failed: {err}");
        }
        // A hash can fail while sync is off and be retried by the book's own
        // backoff. The sweep gives every already-failed book its row, so
        // turning sync on surfaces the failure instead of hiding it.
        if let Err(err) = crate::services::hash_backfill::ensure_failed_issues(pool).await {
            eprintln!("sync issues: hash failure sweep failed: {err}");
        }
        let pending_local: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty")
            .fetch_one(pool)
            .await?;
        // Conflict-kind rows are legacy review leftovers. They never reach the
        // user: the reconcile/expire sweep closes each one once its diagnostic
        // row is gone, so listing them here would show rows nothing can settle.
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

    /// Drain the marker a durable merge writes. The marker survives a failed
    /// pass, so the next pass still tells the renderer to refetch.
    async fn flush_library_reload(&self) -> Result<(), AppError> {
        if get_meta(&self.inner.pool, META_LIBRARY_RELOAD)
            .await?
            .as_deref()
            != Some("1")
        {
            return Ok(());
        }
        set_meta(&self.inner.pool, META_LIBRARY_RELOAD, "0").await?;
        self.emit_library_reload();
        Ok(())
    }

    /// An identity merge can delete the durable record the renderer holds and
    /// create the shared one under a new public id. A per-book upsert cannot
    /// express that, so ask the renderer for the settled list.
    fn emit_library_reload(&self) {
        self.inner
            .events
            .emit("library-changed", &LibraryChange::Reload);
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

    fn sync_root(&self) -> Option<PathBuf> {
        let folder = self.status_snapshot().folder?;
        store::resolve_root(Path::new(&folder)).ok()
    }
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
