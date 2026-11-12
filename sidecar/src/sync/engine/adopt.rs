//! Adoption (ADR 0018 D3): the consumer half of file-version convergence.
//! For every available copy whose bytes are not its book's winning
//! `file_version`, fetch the staged blob `blobs/books/<hash>.<ext>`, verify
//! the hash, replace the local file's bytes, and refresh the file snapshot
//! so the identity sweep rebinds onto the EXISTING book uid on its next
//! pass. Annotations, progress, and locators are untouched.
//!
//! Structural contract: the sweep runs from `run_pass` after a SUCCESSFUL
//! pass, while that call still holds `pass_lock`, mirroring the auto-retry
//! sweep. A failed pass may leave the mirror behind remote ops; adopting
//! from a stale pointer could clobber bytes a newer local edit is about to
//! publish, so adoption waits for a healthy pass and retries on the next
//! one.
//!
//! Open-book deferral (D5): a book whose reader session is open on this
//! device is deferred — `adopt_copy` skips it silently. The ranged reads of
//! a live Readium/PDFium session re-open the file by path, so renamed-in
//! bytes would resolve old offsets: torn pages and decode errors. The
//! registry is in-memory engine state (`super::deferred`), registered by
//! the renderer through `reader_opened`/`reader_closed`. No issue is
//! recorded and the badge stays: it is derived from the unsettled window,
//! which is exactly what an open reader wants to see. The next pass after
//! the reader closes adopts as usual; a missed close self-heals on app
//! exit, when the registry dies with the process.
//!
//! Tolerance rules: a missing blob is op-before-blob arrival (D2) — change
//! nothing, no issue, retry next pass. But a blob the origin never staged
//! (a device storing the book under an extension the origin's copy did not
//! use) would wait forever with zero visibility, so consecutive missing
//! passes surface a `book_file_adopt_failed` row naming the missing blob
//! (informational, self-closing). A blob whose size or hash does not verify
//! is recorded as `book_file_adopt_failed` and retried; the row closes when
//! the winning blob arrives intact or the pointer moves, whichever happens
//! first. A local file whose bytes moved
//! without a rebind (an external edit in flight) is skipped — the
//! reconciler's re-import and the mint guard decide, never adoption.
//! Adoption never deletes anything and never republishes: the swap's own
//! re-import sees binding hash equal to the winning pointer and mints
//! nothing (D1's loop break).

use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::sync::file_version::{self, UnsettledCopy};
use crate::sync::identity;
use crate::sync::store;

use super::clear::resolve_issue_key;
use super::deferred;

/// The sync issue kind for a blob that is present but does not verify.
const ADOPT_FAILED_KIND: &str = "book_file_adopt_failed";

impl super::SyncService {
    /// Adopt winning versions after a pass. Best effort like the other
    /// sweeps: a failure here must not fail the pass that already completed.
    pub(super) async fn adopt_sweep(&self) {
        if let Err(err) = self.adopt_pending().await {
            eprintln!("sync adoption: sweep failed: {err}");
        }
    }

    async fn adopt_pending(&self) -> Result<(), AppError> {
        if !self.status_snapshot().enabled {
            return Ok(());
        }
        let Some(root) = self.sync_root() else {
            return Ok(());
        };
        for copy in file_version::unsettled_copies(&self.inner.pool).await? {
            if let Err(err) = self.adopt_copy(&root, &copy).await {
                // One book's failure must not stall the rest of the sweep.
                // Name the book by its local id: the uid must not reach
                // stderr (CodeQL rust/cleartext-logging).
                eprintln!("sync adoption: book {} adopt failed: {err}", copy.book_id);
            }
        }
        Ok(())
    }

    /// Adopt one copy, or leave it exactly as it was. Every early return is
    /// a "retry next pass" or a settle; only blob verification failures and
    /// the visibility threshold record an issue.
    async fn adopt_copy(&self, root: &Path, copy: &UnsettledCopy) -> Result<(), AppError> {
        if self.is_deferred(&copy.book_uid) {
            // Open-book deferral (ADR 0018 D5): the open session's next
            // ranged reads re-open the file by path, so swapped bytes would
            // resolve old offsets — torn pages and decode errors. Skip
            // silently: no attempt, no issue. The badge is derived from the
            // unsettled window and stays visible for deferred books, which
            // is its purpose; the next pass re-checks, and closing the
            // reader releases the deferral so adoption proceeds then.
            return Ok(());
        }
        let pool = &self.inner.pool;
        let Some(winning) = file_version::winning(pool, &copy.book_uid).await? else {
            return Ok(());
        };
        if winning.content_hash == copy.binding_hash {
            return Ok(());
        }
        // The blob name must pass the same grammar staging used; an
        // extension the importer never admitted names no blob.
        let Some(blob_name) = blob_name_for(&winning.content_hash, &copy.path) else {
            return Ok(());
        };
        if !store::book_blob_exists(root, &blob_name) {
            // Op-before-blob arrival (ADR 0018 D2): the pointer is here, the
            // bytes are still in flight. Silent — but a device that names a
            // blob the origin never staged (its copy carries a different
            // extension) waits forever, so after consecutive missing passes
            // the wait surfaces as an informational row naming the blob.
            if self.record_missing_blob_pass(&copy.book_uid, &winning.content_hash) {
                self.record_missing_blob_issue(copy, &winning, &blob_name)
                    .await?;
            }
            return Ok(());
        }
        // The blob is here: the wait is over, so stop counting against it.
        self.clear_missing_blob(&copy.book_uid);
        let blob_path = root.join(store::BOOK_BLOB_DIR).join(&blob_name);
        let bytes = match read_verified_blob(&blob_path, &winning).await {
            Ok(bytes) => bytes,
            Err(AdoptBlobError::Io(err)) => {
                return self
                    .record_adopt_failure(copy, &winning, &format!("blob unreadable: {err}"))
                    .await;
            }
            Err(AdoptBlobError::Rejected(reason)) => {
                return self.record_adopt_failure(copy, &winning, &reason).await;
            }
        };
        // The local bytes are re-hashed so a stale binding can never cause a
        // swap: settled bytes need no adoption, and bytes that moved without
        // a rebind are an external edit in flight — never adoption's input.
        let local_path = copy.path.clone();
        let local =
            tokio::task::spawn_blocking(move || identity::hash_file(Path::new(&local_path)))
                .await
                .map_err(|err| {
                    AppError::InvalidInput(format!("adoption hash task failed: {err}"))
                })?;
        let Ok((local_hash, _, _)) = local else {
            // The file vanished: a local disappearance is not a shared event
            // (ADR 0013 D6), and the repair path is a re-fetch, not a delete.
            return Ok(());
        };
        if local_hash == winning.content_hash {
            // Already settled — a cloud client delivered the bytes or a
            // previous swap crashed before the rebind. The identity sweep
            // picks the rebind up on its size/mtime divergence.
            return Ok(());
        }
        if local_hash != copy.binding_hash {
            // An external edit is in flight without a re-import yet.
            // Overwriting it here would race the user's own write.
            return Ok(());
        }
        let destination = copy.path.clone();
        tokio::task::spawn_blocking(move || crate::atomic_replace(Path::new(&destination), &bytes))
            .await
            .map_err(|err| AppError::InvalidInput(format!("adoption swap task failed: {err}")))?
            .map_err(AppError::Io)?;
        // Refresh the file snapshot to the new bytes so the identity sweep
        // rehashes exactly once (binding vs snapshot diverge), rebinds onto
        // the existing uid, and settles — the same shape as a re-import's
        // snapshot update.
        let snapshot_path = copy.path.clone();
        let snapshot = tokio::task::spawn_blocking(move || file_stats(Path::new(&snapshot_path)))
            .await
            .map_err(|err| AppError::InvalidInput(format!("adoption stat task failed: {err}")))?;
        if let Some((size, mtime)) = snapshot {
            crate::repository::books::update_file_snapshot(pool, copy.book_id, size, mtime).await?;
        }
        resolve_issue_key(pool, &adopt_issue_key(&copy.book_uid)).await?;
        // Settled: the missing-blob wait (if any was counted) is over.
        self.clear_missing_blob(&copy.book_uid);
        Ok(())
    }

    /// Record the visibility row for a blob that is still missing after
    /// consecutive passes: informational and self-closing — the blob
    /// arriving intact or the pointer moving on resolves the key.
    async fn record_missing_blob_issue(
        &self,
        copy: &UnsettledCopy,
        winning: &file_version::WinningVersion,
        blob_name: &str,
    ) -> Result<(), AppError> {
        let detail = format!(
            "the shared update for this book's file has not arrived after {} \
             passes: '{}' is missing from the sync folder (version {}). \
             Waiting; the local file stays unchanged.",
            deferred::MISSING_BLOB_ISSUE_THRESHOLD,
            blob_name,
            &winning.content_hash[..8.min(winning.content_hash.len())],
        );
        identity::record_issue(
            &self.inner.pool,
            &adopt_issue_key(&copy.book_uid),
            ADOPT_FAILED_KIND,
            &detail,
            file_name(copy).as_deref(),
        )
        .await
    }

    /// Record a verification failure: visible, informational, and retried
    /// by the next pass — adoption is its own retry loop.
    async fn record_adopt_failure(
        &self,
        copy: &UnsettledCopy,
        winning: &file_version::WinningVersion,
        reason: &str,
    ) -> Result<(), AppError> {
        let detail = format!(
            "the shared copy of this book's file (version {}) could not be verified, \
             so the local file was left unchanged: {reason}. Retrying.",
            &winning.content_hash[..8.min(winning.content_hash.len())]
        );
        let file_name = file_name(copy);
        identity::record_issue(
            &self.inner.pool,
            &adopt_issue_key(&copy.book_uid),
            ADOPT_FAILED_KIND,
            &detail,
            file_name.as_deref(),
        )
        .await
    }
}

/// The blob adoption fetches for a copy: the winning hash under the copy's
/// own extension, after the name grammar staging used.
pub(super) fn blob_name_for(hash: &str, path: &str) -> Option<String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    extension.and_then(|ext| store::book_blob_name(&format!("{hash}.{ext}")))
}

/// True when the winning blob for one copy has arrived: the
/// content-addressed file sits in the sync folder and its size and hash
/// verify against the pointer. Presence alone is not arrival — bytes that
/// fail verification keep the wait, and its visibility, open.
pub(super) async fn blob_arrived(
    root: &Path,
    winning: &file_version::WinningVersion,
    path: &str,
) -> bool {
    let Some(blob_name) = blob_name_for(&winning.content_hash, path) else {
        return false;
    };
    if !store::book_blob_exists(root, &blob_name) {
        return false;
    }
    let blob_path = root.join(store::BOOK_BLOB_DIR).join(blob_name);
    read_verified_blob(&blob_path, winning).await.is_ok()
}

/// Why one blob fetch could not be adopted.
enum AdoptBlobError {
    /// The blob file could not be read at all (vanished mid-delivery).
    Io(std::io::Error),
    /// The blob was rejected before adoption: unreadable task result, wrong
    /// size, or wrong hash.
    Rejected(String),
}

/// Read and verify the blob against the winning hash-and-size pair (D1:
/// one coherent value). Content addressing makes the verification free; the
/// size check just rejects a corrupted file before hashing 256 MiB.
async fn read_verified_blob(
    blob_path: &Path,
    winning: &file_version::WinningVersion,
) -> Result<Vec<u8>, AdoptBlobError> {
    let path = blob_path.to_path_buf();
    let expected_hash = winning.content_hash.clone();
    let expected_size = winning.size;
    let result = tokio::task::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|err| AdoptBlobError::Rejected(format!("blob read task failed: {err}")))?
        .map_err(AdoptBlobError::Io)?;
    if result.len() as i64 != expected_size {
        return Err(AdoptBlobError::Rejected(format!(
            "expected {expected_size} bytes, found {}",
            result.len()
        )));
    }
    let actual = format!("{:x}", Sha256::digest(&result));
    if actual != expected_hash {
        return Err(AdoptBlobError::Rejected(format!(
            "expected hash {expected_hash}, found {actual}"
        )));
    }
    Ok(result)
}

/// The file's post-swap stat in the row's convention: unix seconds mtime.
fn file_stats(path: &Path) -> Option<(i64, i64)> {
    let metadata = std::fs::metadata(path).ok()?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    Some((metadata.len() as i64, mtime))
}

/// The copy's file name, for the issue row's label.
fn file_name(copy: &UnsettledCopy) -> Option<String> {
    Path::new(&copy.path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}

fn adopt_issue_key(book_uid: &str) -> String {
    format!("book-file-adopt:{book_uid}")
}
