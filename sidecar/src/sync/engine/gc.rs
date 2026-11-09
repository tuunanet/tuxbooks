//! The staging-folder GC sweep (ADR 0018 D4): prune superseded blobs,
//! stale staging temps, and off-grammar artifacts from `blobs/books/`
//! after the retention window, keeping the winning blob forever.
//!
//! Structural contract: the sweep runs from `run_pass` after a SUCCESSFUL
//! pass, while that call still holds `pass_lock`, mirroring adoption. The
//! winning set is read from the mirror, and only a healthy pass guarantees
//! the mirror already holds every remote pointer; pruning toward a stale
//! one could delete a blob that just became the winner.
//!
//! Cadence: at most once per hour, stamped in `sync_meta`
//! (`gc::BLOB_GC_INTERVAL`), plus once shortly after startup — the first
//! enabled pass of this process sweeps regardless of the stamp, because a
//! device that was offline for weeks should prune soon after boot rather
//! than an hour in. The stamp is written only after a sweep that completed
//! its decision (including the empty-mirror skip), so a failed sweep
//! retries on the next 10-second pass instead of waiting out the hour.
//!
//! Safety: while the mirror holds no `file_version` rows at all, the sweep
//! declines to run — an empty winning set cannot tell a superseded blob
//! from a winner this device has not heard of yet, and a fresh joiner
//! (whose folder may carry months of other devices' blobs with old mtimes)
//! must never mass-delete. Once any pointer lands, the plan runs; until
//! then the window rule alone governs, and nothing older than 90 days can
//! exist that the devices wrote before the join. The listing is collected
//! in full before any deletion, so a listing that fails mid-iteration
//! fails the sweep with nothing removed.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::SystemTime;

use chrono::Utc;

use crate::error::AppError;
use crate::sync::clock::{now_rfc3339, set_meta, META_BLOB_GC};
use crate::sync::gc;
use crate::sync::store;

impl super::SyncService {
    /// Prune superseded blobs after a pass. Best effort like the other
    /// sweeps: a failure here must not fail the pass that already completed.
    pub(super) async fn blob_gc_sweep(&self) {
        if let Err(err) = self.blob_gc().await {
            eprintln!("sync blob gc: sweep failed: {err}");
        }
    }

    async fn blob_gc(&self) -> Result<(), AppError> {
        if !self.status_snapshot().enabled {
            return Ok(());
        }
        // A GC with no folder is a no-op.
        let Some(root) = self.sync_root() else {
            return Ok(());
        };
        // The startup run: consume the boot flag only after the gates, so
        // the once-per-process sweep lands on the first enabled pass.
        let startup = !self.inner.blob_gc_boot.swap(true, Ordering::Relaxed);
        if !startup && !gc::gc_due(&self.inner.pool, Utc::now()).await? {
            return Ok(());
        }
        // Not enough information: no `file_version` rows, no winners, no
        // plan (see the module docs). The pass still counts — stamp it, so
        // the folder is listed hourly, never on every 10-second pass.
        let winning = gc::winning_hashes(&self.inner.pool).await?;
        if winning.is_empty() {
            return self.stamp_gc().await;
        }
        // List first, all of it: any IO error propagates here, before a
        // single deletion decision has been acted on.
        let dir = root.join(store::BOOK_BLOB_DIR);
        let listing_dir = dir.clone();
        let entries = tokio::task::spawn_blocking(move || list_blobs(&listing_dir))
            .await
            .map_err(|err| {
                AppError::InvalidInput(format!("blob gc listing task failed: {err}"))
            })??;
        let delete = gc::gc_plan(&winning, &entries, SystemTime::now());
        // Plain removals, off the reactor (a folder can hold hundreds of
        // blobs, and a cloud client can make one removal slow). One
        // undeletable file must not stall the rest; whatever stayed is
        // retried on a later sweep, and the stamp still moves so a wedged
        // file cannot turn the sweep into a hot loop.
        let targets: Vec<PathBuf> = delete.iter().map(|name| dir.join(name)).collect();
        let failures = tokio::task::spawn_blocking(move || remove_all(&targets))
            .await
            .map_err(|err| AppError::InvalidInput(format!("blob gc removal task failed: {err}")))?;
        for (path, err) in failures {
            eprintln!("sync blob gc: could not remove {}: {err}", path.display());
        }
        self.stamp_gc().await
    }

    /// The cadence stamp: "a sweep decision completed at". RFC3339 like the
    /// other `sync_meta` timestamps.
    async fn stamp_gc(&self) -> Result<(), AppError> {
        set_meta(&self.inner.pool, META_BLOB_GC, &now_rfc3339()).await
    }
}

/// Every regular file directly inside the blob folder, with mtimes.
/// Subdirectories are skipped, never descended. Any error — including one
/// found after many entries — propagates, so the caller deletes nothing.
fn list_blobs(dir: &Path) -> std::io::Result<Vec<gc::BlobDirEntry>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        entries.push(gc::BlobDirEntry { name, modified });
    }
    Ok(entries)
}

/// Remove the planned targets. A file another device's GC already removed
/// is success, not failure — the folder is eventually consistent.
fn remove_all(targets: &[PathBuf]) -> Vec<(PathBuf, std::io::Error)> {
    let mut failures = Vec::new();
    for target in targets {
        if let Err(err) = std::fs::remove_file(target) {
            if err.kind() != std::io::ErrorKind::NotFound {
                failures.push((target.clone(), err));
            }
        }
    }
    failures
}
