//! Drain local dirty markers into immutable operation files.
//!
//! The trigger snapshot is the source of truth here, not the current row. A
//! remote projection that lands between the edit and this pass must not erase
//! the edit the user made.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use sqlx::SqlitePool;

use crate::error::AppError;

use super::clock::{next_hlc, now_rfc3339};
use super::identity::{canonical_book_uid, canonical_entity_uid, record_issue};
use super::merge;
use super::model::{
    canonical_from_snapshot, changed_fields, is_safe_uid, EntityKind, Op, State, OP_SCHEMA,
};
use super::store;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CaptureReport {
    pub written: usize,
    pub pending_identity: usize,
}

struct DirtyRow {
    kind: String,
    entity_key: String,
    op: String,
    old_json: Option<String>,
    new_json: Option<String>,
}

enum Captured {
    Written,
    PendingIdentity,
    Skipped,
}

type DirtyRowTuple = (String, String, String, Option<String>, Option<String>);

pub async fn drain(
    pool: &SqlitePool,
    root: &std::path::Path,
    covers_dir: &std::path::Path,
    limit: i64,
) -> Result<CaptureReport, AppError> {
    let rows: Vec<DirtyRowTuple> = sqlx::query_as(
        "SELECT kind, entity_key, op, old_json, new_json FROM sync_dirty ORDER BY rowid LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    let mut report = CaptureReport::default();
    for (kind, entity_key, op, old_json, new_json) in rows {
        let row = DirtyRow {
            kind,
            entity_key,
            op,
            old_json,
            new_json,
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
    // Progress, opened, and metadata all key on the durable book now. The
    // trigger snapshot is authoritative even before the identity sweep has
    // hashed the book; aliases converge later if two devices chose different
    // uuids for the same bytes.
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
        state,
    )
    .await?;
    clear_row(pool, row).await?;
    Ok(Captured::Written)
}

/// Forget and restore are whole-book lifecycle operations. The local trash
/// row carries the snapshot; the mirror sees one `book` entity with a
/// tombstone (Forget) or a restore, never a tombstone per annotation.
async fn capture_book(
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
                    "book_snapshot_invalid",
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
            "book_snapshot_missing",
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
        )
        .await?;
        write_and_apply(pool, root, &op).await?;
    }
    clear_row(pool, row).await?;
    Ok(Captured::Written)
}

async fn capture_membership(
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
        state,
    )
    .await?;
    clear_row(pool, row).await?;
    Ok(Captured::Written)
}

// The op builder names every wire field explicitly; grouping them into a
// struct only moves the same arguments one level away.
#[allow(clippy::too_many_arguments)]
async fn emit_state(
    pool: &SqlitePool,
    root: &std::path::Path,
    kind: EntityKind,
    entity_uid: &str,
    book_uid: Option<&str>,
    deleted: bool,
    restore: bool,
    state: State,
) -> Result<(), AppError> {
    let (previous, was_deleted) = merge::load_state(pool, kind, entity_uid).await?;
    if deleted {
        if was_deleted || previous.values().all(Value::is_null) {
            return Ok(());
        }
        let prior: Map<String, Value> = previous.into_iter().collect();
        let op = build_op(
            pool,
            kind,
            entity_uid,
            book_uid,
            true,
            false,
            Map::new(),
            Some(prior),
        )
        .await?;
        write_and_apply(pool, root, &op).await?;
        return Ok(());
    }
    if was_deleted && !restore {
        // The mirror has a tombstone; a local edit does not resurrect it,
        // but the text is preserved as an inspectable conflict.
        merge::record_tombstone_conflict(pool, kind, entity_uid, &state).await?;
        return Ok(());
    }
    let changed = changed_fields(&previous, &state);
    if changed.is_empty() {
        return Ok(());
    }
    let fields = if kind.merge_mode() == super::model::MergeMode::Entity {
        state.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    } else {
        changed
    };
    let op = build_op(
        pool, kind, entity_uid, book_uid, false, restore, fields, None,
    )
    .await?;
    write_and_apply(pool, root, &op).await?;
    Ok(())
}

/// Explicitly restore a tombstoned entity from the trash payload. This is the
/// only path that sets `restore`, which is what keeps a concurrent edit from
/// resurrecting a delete.
pub async fn write_restore(
    pool: &SqlitePool,
    root: &std::path::Path,
    kind: EntityKind,
    entity_uid: &str,
    book_uid: Option<&str>,
    prior: &Map<String, Value>,
) -> Result<(), AppError> {
    let state = canonical_from_snapshot(kind, prior);
    let op = build_op(
        pool,
        kind,
        entity_uid,
        book_uid,
        false,
        true,
        state.into_iter().collect(),
        None,
    )
    .await?;
    write_and_apply(pool, root, &op).await
}

#[allow(clippy::too_many_arguments)]
async fn build_op(
    pool: &SqlitePool,
    kind: EntityKind,
    entity_uid: &str,
    book_uid: Option<&str>,
    deleted: bool,
    restore: bool,
    fields: Map<String, Value>,
    prior: Option<Map<String, Value>>,
) -> Result<Op, AppError> {
    let hlc = next_hlc(pool).await?;
    let op_id: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
        .fetch_one(pool)
        .await?;
    Ok(Op {
        schema: OP_SCHEMA,
        op_id,
        device_id: hlc.device.clone(),
        hlc,
        kind,
        entity_uid: entity_uid.to_string(),
        book_uid: book_uid.map(ToString::to_string),
        deleted,
        restore,
        fields,
        prior,
        created_at: now_rfc3339(),
    })
}

async fn write_and_apply(
    pool: &SqlitePool,
    root: &std::path::Path,
    op: &Op,
) -> Result<(), AppError> {
    let relative = store::write_op(root, op)?;
    let payload = serde_json::to_string(op)
        .map_err(|err| AppError::InvalidInput(format!("cannot serialize op: {err}")))?;
    merge::apply_op(pool, op, &relative).await?;
    sqlx::query(
        r#"
        INSERT INTO sync_ops
            (op_id, device_id, hlc_wall, hlc_counter, kind, entity_uid, book_uid,
             deleted, payload_json, file_name)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(op_id) DO NOTHING
        "#,
    )
    .bind(&op.op_id)
    .bind(&op.device_id)
    .bind(op.hlc.wall)
    .bind(op.hlc.counter as i64)
    .bind(op.kind.as_str())
    .bind(&op.entity_uid)
    .bind(&op.book_uid)
    .bind(op.deleted)
    .bind(payload)
    .bind(relative)
    .execute(pool)
    .await?;
    Ok(())
}

async fn clear_row(pool: &SqlitePool, row: &DirtyRow) -> Result<(), AppError> {
    sqlx::query(
        "DELETE FROM sync_dirty WHERE kind = ?1 AND entity_key = ?2 AND op = ?3
         AND COALESCE(old_json, '') = COALESCE(?4, '')
         AND COALESCE(new_json, '') = COALESCE(?5, '')",
    )
    .bind(&row.kind)
    .bind(&row.entity_key)
    .bind(&row.op)
    .bind(&row.old_json)
    .bind(&row.new_json)
    .execute(pool)
    .await?;
    Ok(())
}

async fn durable_exists(pool: &SqlitePool, uid: &str) -> Result<bool, AppError> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM book_records WHERE uid = ?1")
        .bind(uid)
        .fetch_optional(pool)
        .await?;
    Ok(exists.is_some())
}

/// The canonical durable uid behind a public numeric book id, when the book
/// still has a durable record.
async fn durable_uid(pool: &SqlitePool, book_id: i64) -> Result<Option<String>, AppError> {
    let uid: Option<String> = sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
        .bind(book_id)
        .fetch_optional(pool)
        .await?;
    match uid {
        Some(uid) => Ok(Some(canonical_book_uid(pool, &uid).await?)),
        None => Ok(None),
    }
}

async fn collection_exists(pool: &SqlitePool, collection_id: i64) -> Result<bool, AppError> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM collections WHERE id = ?1")
        .bind(collection_id)
        .fetch_optional(pool)
        .await?;
    Ok(exists.is_some())
}

async fn resolve_local_uid(
    pool: &SqlitePool,
    table: &str,
    id: i64,
    snapshot_uid: Option<&str>,
    deleted: bool,
) -> Result<Option<String>, AppError> {
    if let Some(uid) = snapshot_uid {
        if !uid.is_empty() && is_safe_uid(uid) {
            return Ok(Some(uid.to_string()));
        }
    }
    if deleted {
        return Ok(None);
    }
    let query = format!("SELECT sync_uid FROM {table} WHERE id = ?1");
    let uid: Option<String> = sqlx::query_scalar(&query)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .flatten();
    if let Some(uid) = uid {
        return Ok(Some(uid));
    }
    let generated: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
        .fetch_one(pool)
        .await?;
    let update = format!("UPDATE {table} SET sync_uid = ?2 WHERE id = ?1");
    sqlx::query(&update)
        .bind(id)
        .bind(&generated)
        .execute(pool)
        .await?;
    Ok(Some(generated))
}

fn parse_snapshot(value: Option<&str>) -> Option<Map<String, Value>> {
    let text = value?;
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

fn snapshot_for(row: &DirtyRow) -> Option<Map<String, Value>> {
    match row.op.as_str() {
        "delete" => parse_snapshot(row.old_json.as_deref()),
        _ => parse_snapshot(row.new_json.as_deref()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn skips_a_state_row_when_its_book_is_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        // No books row. A stale dirty marker must be dropped, not turned into
        // a shared delete.
        sqlx::query(
            "INSERT INTO sync_dirty (kind, entity_key, op, old_json)
             VALUES ('progress', '999', 'delete', '{}')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let root = store::resolve_root(tmp.path()).unwrap();
        let covers = tmp.path().join("covers");
        let report = drain(&pool, &root, &covers, 10).await.unwrap();
        assert_eq!(report.written, 0);
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
    }

    #[tokio::test]
    async fn annotation_capture_uses_the_durable_uid_without_a_hash_binding() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let (book_id, _) = crate::repository::books::upsert_book(
            &pool,
            &crate::domain::NewBook {
                path: "/tmp/unhashed.epub".into(),
                title: "Unhashed".into(),
                subtitle: None,
                author: None,
                authors: Vec::new(),
                subjects: Vec::new(),
                publisher: None,
                language: None,
                isbn: None,
                description: None,
                publication_date: None,
                series: None,
                series_index: None,
                cover_path: None,
                file_size: 0,
                file_mtime: 0,
            },
        )
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO annotations (book_uid, kind, cfi, text)
             SELECT uid, 'bookmark', 'epubcfi(/6/4)', 'before the hash' FROM book_records WHERE id = ?1",
        )
        .bind(book_id)
        .execute(&pool)
        .await
        .unwrap();

        let marker: String =
            sqlx::query_scalar("SELECT new_json FROM sync_dirty WHERE kind = 'annotation' LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            marker.contains("\"book_uid\""),
            "the trigger carries the durable key: {marker}"
        );

        let root = store::resolve_root(tmp.path()).unwrap();
        let covers = tmp.path().join("covers");
        let report = drain(&pool, &root, &covers, 10).await.unwrap();
        assert_eq!(report.written, 1, "capture does not wait for a binding");
        let bindings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_bindings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(bindings, 0);
    }
}
