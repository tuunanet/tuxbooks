//! Dirty-row dispatch: one capture path per entity kind.

use serde_json::{Map, Value};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::identity::{canonical_book_uid, canonical_entity_uid, record_issue};
use crate::sync::model::{canonical_from_snapshot, EntityKind};
use crate::sync::store;

use super::lifecycle::{capture_book, capture_membership};
use super::publish::{emit_state, resolve_local_uid};
use super::{
    build_op, clear_row, durable_exists, durable_uid, parse_snapshot, snapshot_for, stored_clock,
    write_and_apply, CaptureReport, Captured, DirtyRow, DirtyRowTuple,
};

pub async fn drain(
    pool: &SqlitePool,
    root: &std::path::Path,
    covers_dir: &std::path::Path,
    limit: i64,
) -> Result<CaptureReport, AppError> {
    let rows: Vec<DirtyRowTuple> = sqlx::query_as(
        "SELECT kind, entity_key, op, old_json, new_json, hlc_wall, hlc_counter
         FROM sync_dirty ORDER BY rowid LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    let mut report = CaptureReport::default();
    for (kind, entity_key, op, old_json, new_json, hlc_wall, hlc_counter) in rows {
        let row = DirtyRow {
            kind,
            entity_key,
            op,
            old_json,
            new_json,
            hlc_wall,
            hlc_counter,
        };
        match capture_one(pool, root, covers_dir, &row).await? {
            Captured::Written => report.written += 1,
            Captured::PendingIdentity => report.pending_identity += 1,
            Captured::Skipped => {}
        }
    }
    Ok(report)
}

async fn capture_one(
    pool: &SqlitePool,
    root: &std::path::Path,
    covers_dir: &std::path::Path,
    row: &DirtyRow,
) -> Result<Captured, AppError> {
    let Some(kind) = EntityKind::parse(&row.kind) else {
        record_issue(
            pool,
            &format!("dirty-kind:{}", row.kind),
            "invalid_dirty_kind",
            &format!("unknown dirty marker kind {}", row.kind),
            None,
        )
        .await?;
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    match kind {
        EntityKind::BookIdentity => capture_identity(pool, root, row).await,
        EntityKind::Annotation => capture_annotation(pool, root, row).await,
        EntityKind::Collection => capture_collection(pool, root, row).await,
        EntityKind::Progress | EntityKind::Opened | EntityKind::Metadata => {
            capture_book_state(pool, root, covers_dir, row, kind).await
        }
        EntityKind::Membership => capture_membership(pool, root, row).await,
        EntityKind::Book => capture_book(pool, root, row).await,
        EntityKind::FileVersion => super::file_version::capture_file_version(pool, root, row).await,
    }
}

async fn capture_identity(
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
    let Some(uid) = snapshot.get("book_uid").and_then(Value::as_str) else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    let uid = canonical_book_uid(pool, uid).await?;
    let mut fields = Map::new();
    fields.insert("content_hash".into(), Value::String(hash.into()));
    let op = build_op(
        pool,
        EntityKind::BookIdentity,
        &uid,
        Some(&uid),
        false,
        false,
        fields,
        None,
        stored_clock(row),
    )
    .await?;
    write_and_apply(pool, root, &op).await?;
    clear_row(pool, row).await?;
    Ok(Captured::Written)
}

async fn capture_annotation(
    pool: &SqlitePool,
    root: &std::path::Path,
    row: &DirtyRow,
) -> Result<Captured, AppError> {
    let Some(snapshot) = snapshot_for(row) else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    // 0023 triggers carry the durable key beside the public id. Older markers
    // and fixtures may still only have the numeric id.
    let book_uid = match snapshot.get("book_uid").and_then(Value::as_str) {
        Some(uid) => uid.to_string(),
        None => {
            let Some(book_id) = snapshot.get("book_id").and_then(Value::as_i64) else {
                clear_row(pool, row).await?;
                return Ok(Captured::Skipped);
            };
            let Some(uid) = durable_uid(pool, book_id).await? else {
                clear_row(pool, row).await?;
                return Ok(Captured::Skipped);
            };
            uid
        }
    };
    let annotation_id = row
        .entity_key
        .parse::<i64>()
        .map_err(|_| AppError::InvalidInput("bad annotation dirty key".into()))?;
    let Some(uid) = resolve_local_uid(
        pool,
        "annotations",
        annotation_id,
        snapshot.get("sync_uid").and_then(Value::as_str),
        row.op == "delete",
    )
    .await?
    else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    let state = canonical_from_snapshot(EntityKind::Annotation, &snapshot);
    emit_state(
        pool,
        root,
        EntityKind::Annotation,
        &uid,
        Some(&book_uid),
        row.op == "delete",
        false,
        stored_clock(row),
        state,
    )
    .await?;
    clear_row(pool, row).await?;
    Ok(Captured::Written)
}

async fn capture_collection(
    pool: &SqlitePool,
    root: &std::path::Path,
    row: &DirtyRow,
) -> Result<Captured, AppError> {
    let Some(snapshot) = snapshot_for(row) else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    let local_id = row
        .entity_key
        .parse::<i64>()
        .map_err(|_| AppError::InvalidInput("bad collection dirty key".into()))?;
    let Some(uid) = resolve_local_uid(
        pool,
        "collections",
        local_id,
        snapshot.get("sync_uid").and_then(Value::as_str),
        row.op == "delete",
    )
    .await?
    else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    let uid = canonical_entity_uid(pool, EntityKind::Collection, &uid).await?;
    let state = canonical_from_snapshot(EntityKind::Collection, &snapshot);
    emit_state(
        pool,
        root,
        EntityKind::Collection,
        &uid,
        None,
        row.op == "delete",
        false,
        stored_clock(row),
        state,
    )
    .await?;
    clear_row(pool, row).await?;
    Ok(Captured::Written)
}

async fn capture_book_state(
    pool: &SqlitePool,
    root: &std::path::Path,
    covers_dir: &std::path::Path,
    row: &DirtyRow,
    kind: EntityKind,
) -> Result<Captured, AppError> {
    // Progress, opened, and metadata key on the durable book; the trigger
    // snapshot is authoritative even before the identity sweep has hashed.
    let uid = row.entity_key.clone();
    if !durable_exists(pool, &uid).await? {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    }
    let Some(mut snapshot) = snapshot_for(row) else {
        clear_row(pool, row).await?;
        return Ok(Captured::Skipped);
    };
    if kind == EntityKind::Metadata {
        let cover = snapshot
            .get("cover_path")
            .and_then(Value::as_str)
            .and_then(store::cover_file_name);
        if let Some(name) = &cover {
            if let Err(err) = store::store_cover_blob(root, covers_dir, name) {
                record_issue(
                    pool,
                    &format!("cover:{name}"),
                    "cover_blob_failed",
                    &format!("could not publish cover {name}: {err}"),
                    None,
                )
                .await?;
            }
        }
        snapshot.insert(
            "cover_path".into(),
            cover.map(Value::String).unwrap_or(Value::Null),
        );
    }
    let state = canonical_from_snapshot(kind, &snapshot);
    emit_state(
        pool,
        root,
        kind,
        &uid,
        Some(&uid),
        row.op == "delete",
        false,
        stored_clock(row),
        state,
    )
    .await?;
    clear_row(pool, row).await?;
    Ok(Captured::Written)
}
