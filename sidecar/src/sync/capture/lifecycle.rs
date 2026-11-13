//! Whole-book lifecycle and membership capture paths.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::identity::{canonical_book_uid, canonical_entity_uid, record_issue};
use crate::sync::kind::SyncIssueKind;
use crate::sync::merge;
use crate::sync::model::{EntityKind, State};

use super::publish::{emit_state, resolve_local_uid};
use super::{
    build_op, clear_row, collection_exists, durable_exists, parse_snapshot, snapshot_for,
    stored_clock, write_and_apply, Captured, DirtyRow,
};

/// Forget and restore are whole-book lifecycle operations: the mirror sees
/// one `book` tombstone or restore, never a tombstone per annotation.
pub(super) async fn capture_book(
    pool: &SqlitePool,
    root: &std::path::Path,
    row: &DirtyRow,
) -> Result<Captured, AppError> {
    let payload = match row.op.as_str() {
        "delete" => parse_snapshot(row.old_json.as_deref()),
        _ => parse_snapshot(row.new_json.as_deref()),
    };
    let Some(payload) = payload else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    let uid = row.entity_key.clone();
    let replacement = payload
        .get("replacement_book_uid")
        .and_then(Value::as_str)
        .map(str::to_string);
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("restore");
    let (mirror_deleted, trash_restored) = merge::book_lifecycle_state(pool, &uid).await?;

    if row.op == "delete" {
        // A projection that materialized a remote trash row fires this marker
        // again; the mirror already holds the tombstone.
        if mirror_deleted {
            clear_row(pool, row).await?;
            return Ok(Captured::Skipped);
        }
    } else if trash_restored {
        // Echo of a remote restore/discard projection.
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    }

    let snapshot = match payload.get("snapshot_json").and_then(Value::as_str) {
        Some(raw) => match crate::repository::lifecycle::shared_snapshot_json(pool, raw).await {
            Ok(snapshot) => snapshot,
            Err(err) => {
                record_issue(
                    pool,
                    &format!("book-snapshot:{uid}"),
                    SyncIssueKind::BookSnapshotInvalid,
                    &format!(
                        "could not publish the forgotten book snapshot: {err}; \
                         other machines will not be able to restore it"
                    ),
                    None,
                )
                .await?;
                None
            }
        },
        None => None,
    };
    if snapshot.is_none() && action != "discard" {
        record_issue(
            pool,
            &format!("book-snapshot-missing:{uid}"),
            SyncIssueKind::BookSnapshotMissing,
            "this book was forgotten without a portable snapshot; other machines \
             will see the delete but cannot offer a restore",
            None,
        )
        .await?;
    }

    if row.op == "delete" {
        let mut prior = Map::new();
        prior.insert(
            "snapshot".into(),
            snapshot.map(Value::String).unwrap_or(Value::Null),
        );
        prior.insert(
            "replacement_book_uid".into(),
            replacement.map(Value::String).unwrap_or(Value::Null),
        );
        prior.insert("discarded".into(), Value::Null);
        let op = build_op(
            pool,
            EntityKind::Book,
            &uid,
            Some(&uid),
            true,
            false,
            Map::new(),
            Some(prior),
            stored_clock(row),
        )
        .await?;
        write_and_apply(pool, root, &op).await?;
    } else {
        let mut fields = Map::new();
        if action == "discard" {
            fields.insert("discarded".into(), Value::Bool(true));
            fields.insert("snapshot".into(), Value::Null);
        } else {
            fields.insert(
                "snapshot".into(),
                snapshot.map(Value::String).unwrap_or(Value::Null),
            );
            fields.insert("discarded".into(), Value::Bool(false));
        }
        fields.insert(
            "replacement_book_uid".into(),
            replacement.map(Value::String).unwrap_or(Value::Null),
        );
        let op = build_op(
            pool,
            EntityKind::Book,
            &uid,
            Some(&uid),
            false,
            true,
            fields,
            None,
            stored_clock(row),
        )
        .await?;
        write_and_apply(pool, root, &op).await?;
    }
    clear_row(pool, row).await?;
    Ok(Captured::Written)
}

pub(super) async fn capture_membership(
    pool: &SqlitePool,
    root: &std::path::Path,
    row: &DirtyRow,
) -> Result<Captured, AppError> {
    let Some(snapshot) = snapshot_for(row) else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    let Some(uid) = snapshot.get("book_uid").and_then(Value::as_str) else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    let Some(collection_id) = snapshot.get("collection_id").and_then(Value::as_i64) else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    if !durable_exists(pool, uid).await? || !collection_exists(pool, collection_id).await? {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    }
    let Some(collection_uid) =
        resolve_local_uid(pool, "collections", collection_id, None, false).await?
    else {
        return Ok(Captured::PendingIdentity);
    };
    let collection_uid =
        canonical_entity_uid(pool, EntityKind::Collection, &collection_uid).await?;
    let book_uid = canonical_book_uid(pool, uid).await?;
    let entity_uid = format!("{collection_uid}:{book_uid}");
    let mut state: State = BTreeMap::new();
    let present = row.op != "delete"
        && snapshot
            .get("present")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    state.insert("present".into(), Value::Bool(present));
    state.insert(
        "added_at".into(),
        snapshot.get("added_at").cloned().unwrap_or(Value::Null),
    );
    emit_state(
        pool,
        root,
        EntityKind::Membership,
        &entity_uid,
        Some(&book_uid),
        false,
        false,
        stored_clock(row),
        state,
    )
    .await?;
    clear_row(pool, row).await?;
    Ok(Captured::Written)
}
