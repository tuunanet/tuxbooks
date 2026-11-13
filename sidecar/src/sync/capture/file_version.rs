//! The `file_version` capture path (ADR 0018 D1/D2): stage the blob into
//! `blobs/books/`, then publish the pointer operation. Staging first is the
//! origin-side half of the ordering contract; consumers still cannot assume
//! arrival order and wait for the hash to verify.

use std::path::Path;

use serde_json::Value;
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::file_version;
use crate::sync::identity::{canonical_book_uid, record_issue};
use crate::sync::kind::SyncIssueKind;
use crate::sync::model::{canonical_from_snapshot, EntityKind};
use crate::sync::store::{self, BookBlobStage};

use super::publish::emit_state;
use super::{clear_row, durable_exists, parse_snapshot, stored_clock, Captured, DirtyRow};

pub(super) async fn capture_file_version(
    pool: &SqlitePool,
    root: &std::path::Path,
    row: &DirtyRow,
) -> Result<Captured, AppError> {
    let Some(snapshot) = parse_snapshot(row.new_json.as_deref()) else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    let Some(hash) = snapshot.get("content_hash").and_then(Value::as_str) else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    if snapshot.get("size").and_then(Value::as_i64).is_none() {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    // Identity merges can move the book after the mint was recorded.
    let uid = canonical_book_uid(pool, &row.entity_key).await?;
    if !durable_exists(pool, &uid).await? {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    }
    // The loop break, re-checked at drain: the winning pointer may have moved
    // since the mint (a remote version landed) — never republish its hash.
    if file_version::winning(pool, &uid)
        .await?
        .is_some_and(|winning| winning.content_hash == hash)
    {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    }
    let Some(path) = file_version::file_path_for_hash(pool, &uid, hash).await? else {
        // The bytes that were minted are gone or were replaced: a local
        // disappearance is not a shared event (ADR 0013 D6). Drop the mint;
        // the file's return re-imports and re-mints if the hash differs.
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    if !Path::new(&path).exists() {
        // The binding still names the minted bytes, but the file itself left
        // between the mint and this pass. Same local-disappearance rule.
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    // Stage BEFORE publishing (D2). The staging re-verifies the hash, so the
    // staged name is always the staged content. The blocking pool owns the
    // read: a 256 MiB book must not stall the reactor.
    let staging_root = root.to_path_buf();
    let staging_hash = hash.to_string();
    let staged = tokio::task::spawn_blocking(move || {
        store::stage_book_blob(&staging_root, Path::new(&path), &staging_hash)
    })
    .await
    .map_err(|err| AppError::InvalidInput(format!("blob staging task failed: {err}")))??;
    match staged {
        BookBlobStage::Oversize => {
            record_issue(
                pool,
                &format!("book-blob-oversize:{uid}"),
                SyncIssueKind::BookBlobOversize,
                "the file for this book is larger than the 256 MiB sync limit, \
                     so its bytes cannot be shared. Shrink the file or raise the cap; \
                     the reading state still syncs.",
                None,
            )
            .await?;
            clear_row(pool, row).await?;
            return Ok(Captured::Skipped);
        }
        BookBlobStage::Stored => {}
    }
    let state = canonical_from_snapshot(EntityKind::FileVersion, &snapshot);
    emit_state(
        pool,
        root,
        EntityKind::FileVersion,
        &uid,
        Some(&uid),
        false,
        false,
        stored_clock(row),
        state,
    )
    .await?;
    clear_row(pool, row).await?;
    Ok(Captured::Written)
}
