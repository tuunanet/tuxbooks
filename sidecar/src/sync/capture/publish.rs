//! Publishing helpers: state emission and the public write entry points.

use serde_json::{Map, Value};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::merge;
use crate::sync::model::{
    canonical_from_snapshot, changed_fields, is_safe_uid, EntityKind, Hlc, MergeMode, State,
};

use super::{build_op, write_and_apply};

// The op builder names every wire field explicitly; grouping them into a
// struct only moves the same arguments one level away.
#[allow(clippy::too_many_arguments)]
pub(super) async fn emit_state(
    pool: &SqlitePool,
    root: &std::path::Path,
    kind: EntityKind,
    entity_uid: &str,
    book_uid: Option<&str>,
    deleted: bool,
    restore: bool,
    clock: Option<Hlc>,
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
            clock,
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
    let fields = if kind.merge_mode() == MergeMode::Entity {
        state.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    } else {
        changed
    };
    let op = build_op(
        pool, kind, entity_uid, book_uid, false, restore, fields, None, clock,
    )
    .await?;
    write_and_apply(pool, root, &op).await?;
    Ok(())
}

/// Publish a normal state operation with a fresh clock. Conflict resolution
/// reuses this so a re-applied losing value is an ordinary write every device
/// converges on; the write happens now, so minting now is its write time.
pub async fn write_fields(
    pool: &SqlitePool,
    root: &std::path::Path,
    kind: EntityKind,
    entity_uid: &str,
    book_uid: Option<&str>,
    fields: Map<String, Value>,
) -> Result<(), AppError> {
    let op = build_op(
        pool, kind, entity_uid, book_uid, false, false, fields, None, None,
    )
    .await?;
    write_and_apply(pool, root, &op).await
}

/// Explicitly restore a tombstoned entity from the trash payload. The only
/// path that sets `restore`, which keeps a concurrent edit from resurrecting
/// a delete; the restore happens now, so a fresh mint is its write time.
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
        None,
    )
    .await?;
    write_and_apply(pool, root, &op).await
}

pub(super) async fn resolve_local_uid(
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
