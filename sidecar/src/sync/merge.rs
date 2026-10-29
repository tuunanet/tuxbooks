//! Merge remote operations into the shared-state mirror.
//!
//! Field-level last-writer-wins for annotations, metadata, and collections;
//! entity-level last-writer-wins for reading progress, membership, and
//! last-opened; delete-wins tombstones for annotations and collections, with
//! an explicit restore path.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppError;

use super::clock::{now_rfc3339, observe_hlc};
use super::identity::merge_book_identity;
use super::model::{
    canonical_from_snapshot, field_names, EntityKind, Hlc, MergeMode, Op, State, TRASH_DAYS,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Affected {
    pub kind: EntityKind,
    pub entity_uid: String,
    pub book_uid: Option<String>,
}

/// Apply one operation idempotently. The caller records the file it came from
/// so the dedupe table can explain where an op was first seen.
pub async fn apply_op(
    pool: &SqlitePool,
    op: &Op,
    file_name: &str,
) -> Result<Vec<Affected>, AppError> {
    let already: Option<String> =
        sqlx::query_scalar("SELECT op_id FROM sync_applied_ops WHERE op_id = ?1")
            .bind(&op.op_id)
            .fetch_optional(pool)
            .await?;
    if already.is_some() {
        return Ok(Vec::new());
    }
    observe_hlc(pool, &op.hlc).await?;

    if op.kind == EntityKind::BookIdentity {
        let affected = apply_identity(pool, op).await?;
        sqlx::query(
            "INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, file_name)
             VALUES (?1, ?2, ?3)",
        )
        .bind(&op.op_id)
        .bind(&op.device_id)
        .bind(file_name)
        .execute(pool)
        .await?;
        return Ok(affected);
    }

    let mut tx = pool.begin().await?;
    let affected = apply_state_op(&mut tx, op).await?;
    sqlx::query(
        "INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, file_name) VALUES (?1, ?2, ?3)",
    )
    .bind(&op.op_id)
    .bind(&op.device_id)
    .bind(file_name)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(affected)
}

/// Identity ops are applied outside the state transaction because the merge
/// can re-key many rows and uses its own transaction. Every step is
/// idempotent; if this crashes before the op is marked applied, the next pass
/// repeats it.
async fn apply_identity(pool: &SqlitePool, op: &Op) -> Result<Vec<Affected>, AppError> {
    let content_hash = op
        .fields
        .get("content_hash")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::InvalidInput("identity op is missing content_hash".into()))?;
    let incoming = super::identity::canonical_book_uid(pool, &op.entity_uid).await?;
    let existing: Option<String> =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(content_hash)
            .fetch_optional(pool)
            .await?;
    let canonical = match existing {
        Some(existing) => {
            let existing = super::identity::canonical_book_uid(pool, &existing).await?;
            let canonical = existing.clone().min(incoming.clone());
            if existing != canonical {
                merge_book_identity(pool, &existing, &canonical).await?;
            }
            canonical
        }
        None => incoming.clone(),
    };
    if canonical != incoming {
        merge_book_identity(pool, &incoming, &canonical).await?;
    }
    sqlx::query(
        r#"
        INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)
        ON CONFLICT(content_hash) DO UPDATE SET book_uid = excluded.book_uid
        "#,
    )
    .bind(content_hash)
    .bind(&canonical)
    .execute(pool)
    .await?;
    Ok(vec![Affected {
        kind: EntityKind::BookIdentity,
        entity_uid: canonical.clone(),
        book_uid: Some(canonical),
    }])
}

async fn apply_state_op(
    tx: &mut Transaction<'_, Sqlite>,
    op: &Op,
) -> Result<Vec<Affected>, AppError> {
    let book_uid = match &op.book_uid {
        Some(uid) => Some(canonical_book_uid_tx(tx, uid).await?),
        None => None,
    };
    let entity_uid = match op.kind {
        EntityKind::Collection => canonical_entity_uid_tx(tx, op.kind, &op.entity_uid).await?,
        EntityKind::Membership => {
            let (collection, book) = op
                .entity_uid
                .split_once(':')
                .ok_or_else(|| AppError::InvalidInput("bad membership uid".into()))?;
            let collection =
                canonical_entity_uid_tx(tx, EntityKind::Collection, collection).await?;
            let book = canonical_book_uid_tx(tx, book).await?;
            format!("{collection}:{book}")
        }
        _ => op.entity_uid.clone(),
    };

    sqlx::query(
        r#"
        INSERT INTO sync_state_entities (kind, entity_uid, book_uid) VALUES (?1, ?2, ?3)
        ON CONFLICT(kind, entity_uid) DO UPDATE SET
            book_uid = COALESCE(excluded.book_uid, sync_state_entities.book_uid)
        "#,
    )
    .bind(op.kind.as_str())
    .bind(&entity_uid)
    .bind(&book_uid)
    .execute(&mut **tx)
    .await?;

    if op.deleted {
        apply_delete(tx, op, &entity_uid, &book_uid).await?;
    } else {
        apply_upsert(tx, op, &entity_uid).await?;
    }

    Ok(vec![Affected {
        kind: op.kind,
        entity_uid,
        book_uid,
    }])
}

async fn apply_upsert(
    tx: &mut Transaction<'_, Sqlite>,
    op: &Op,
    entity_uid: &str,
) -> Result<(), AppError> {
    let entity = load_entity(tx, op.kind, entity_uid).await?;
    let deleted = entity.as_ref().is_some_and(|entity| entity.deleted);
    let entity_hlc = entity
        .as_ref()
        .map(|entity| entity.hlc.clone())
        .unwrap_or_else(Hlc::zero);

    if deleted {
        let delete_hlc = entity
            .as_ref()
            .and_then(|entity| entity.deleted_hlc.clone())
            .unwrap_or_else(Hlc::zero);
        let restored_hlc = entity
            .as_ref()
            .and_then(|entity| entity.restored_hlc.clone())
            .unwrap_or_else(Hlc::zero);
        if !op.restore {
            record_conflict(
                tx,
                op.kind,
                entity_uid,
                "__deleted__",
                &Value::String("deleted".into()),
                &Value::Object(op.fields.clone()),
                &delete_hlc,
                &op.hlc,
            )
            .await?;
            return Ok(());
        }
        if restored_hlc > op.hlc || delete_hlc >= op.hlc {
            record_conflict(
                tx,
                op.kind,
                entity_uid,
                "__restore__",
                &Value::String("deleted".into()),
                &Value::Object(op.fields.clone()),
                &delete_hlc,
                &op.hlc,
            )
            .await?;
            return Ok(());
        }
        sqlx::query(
            "UPDATE sync_state_entities SET deleted = 0, restored_wall = ?2,
             restored_count = ?3, restored_dev = ?4 WHERE kind = ?1 AND entity_uid = ?5",
        )
        .bind(op.kind.as_str())
        .bind(op.hlc.wall)
        .bind(op.hlc.counter as i64)
        .bind(&op.hlc.device)
        .bind(entity_uid)
        .execute(&mut **tx)
        .await?;
    }

    match op.kind.merge_mode() {
        MergeMode::Field => apply_fields(tx, op, entity_uid).await?,
        MergeMode::Entity => apply_entity(tx, op, entity_uid, &entity_hlc).await?,
    }
    Ok(())
}

async fn apply_fields(
    tx: &mut Transaction<'_, Sqlite>,
    op: &Op,
    entity_uid: &str,
) -> Result<(), AppError> {
    for (field, value) in &op.fields {
        let existing: Option<(String, i64, i64, String)> = sqlx::query_as(
            "SELECT value_json, hlc_wall, hlc_counter, hlc_device
             FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2 AND field = ?3",
        )
        .bind(op.kind.as_str())
        .bind(entity_uid)
        .bind(field)
        .fetch_optional(&mut **tx)
        .await?;
        let existing_hlc = existing.as_ref().map(|(_, wall, counter, device)| Hlc {
            wall: *wall,
            counter: *counter as u32,
            device: device.clone(),
        });
        let existing_value = existing
            .as_ref()
            .and_then(|(json, _, _, _)| serde_json::from_str::<Value>(json).ok());
        match existing_hlc {
            Some(existing_hlc) if op.hlc <= existing_hlc => {
                if existing_value.as_ref() != Some(value) {
                    record_conflict(
                        tx,
                        op.kind,
                        entity_uid,
                        field,
                        existing_value.as_ref().unwrap_or(&Value::Null),
                        value,
                        &existing_hlc,
                        &op.hlc,
                    )
                    .await?;
                }
            }
            _ => {
                sqlx::query(
                    r#"
                    INSERT INTO sync_state_fields
                        (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                    ON CONFLICT(kind, entity_uid, field) DO UPDATE SET
                        value_json = excluded.value_json,
                        hlc_wall = excluded.hlc_wall,
                        hlc_counter = excluded.hlc_counter,
                        hlc_device = excluded.hlc_device
                    "#,
                )
                .bind(op.kind.as_str())
                .bind(entity_uid)
                .bind(field)
                .bind(serde_json::to_string(value).unwrap_or_else(|_| "null".into()))
                .bind(op.hlc.wall)
                .bind(op.hlc.counter as i64)
                .bind(&op.hlc.device)
                .execute(&mut **tx)
                .await?;
            }
        }
    }
    Ok(())
}

async fn apply_entity(
    tx: &mut Transaction<'_, Sqlite>,
    op: &Op,
    entity_uid: &str,
    entity_hlc: &Hlc,
) -> Result<(), AppError> {
    if &op.hlc <= entity_hlc {
        let current = load_state_tx(tx, op.kind, entity_uid).await?;
        record_conflict(
            tx,
            op.kind,
            entity_uid,
            "__entity__",
            &Value::Object(current.into_iter().collect()),
            &Value::Object(op.fields.clone()),
            entity_hlc,
            &op.hlc,
        )
        .await?;
        return Ok(());
    }
    sqlx::query("DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2")
        .bind(op.kind.as_str())
        .bind(entity_uid)
        .execute(&mut **tx)
        .await?;
    for (field, value) in &op.fields {
        sqlx::query(
            "INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(op.kind.as_str())
        .bind(entity_uid)
        .bind(field)
        .bind(serde_json::to_string(value).unwrap_or_else(|_| "null".into()))
        .bind(op.hlc.wall)
        .bind(op.hlc.counter as i64)
        .bind(&op.hlc.device)
        .execute(&mut **tx)
        .await?;
    }
    sqlx::query(
        "UPDATE sync_state_entities SET hlc_wall = ?2, hlc_counter = ?3, hlc_device = ?4
         WHERE kind = ?1 AND entity_uid = ?5",
    )
    .bind(op.kind.as_str())
    .bind(op.hlc.wall)
    .bind(op.hlc.counter as i64)
    .bind(&op.hlc.device)
    .bind(entity_uid)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn apply_delete(
    tx: &mut Transaction<'_, Sqlite>,
    op: &Op,
    entity_uid: &str,
    book_uid: &Option<String>,
) -> Result<(), AppError> {
    let entity = load_entity(tx, op.kind, entity_uid).await?;
    let already_deleted = entity.as_ref().is_some_and(|entity| entity.deleted);
    if already_deleted {
        return Ok(());
    }
    let restored_hlc = entity
        .as_ref()
        .and_then(|entity| entity.restored_hlc.clone())
        .unwrap_or_else(Hlc::zero);
    if restored_hlc > op.hlc {
        return Ok(());
    }

    if op.kind.merge_mode() == MergeMode::Entity {
        let entity_hlc = entity
            .as_ref()
            .map(|entity| entity.hlc.clone())
            .unwrap_or_else(Hlc::zero);
        if op.hlc < entity_hlc {
            return Ok(());
        }
        sqlx::query(
            "UPDATE sync_state_entities SET deleted = 1, deleted_wall = ?2,
             deleted_count = ?3, deleted_dev = ?4 WHERE kind = ?1 AND entity_uid = ?5",
        )
        .bind(op.kind.as_str())
        .bind(op.hlc.wall)
        .bind(op.hlc.counter as i64)
        .bind(&op.hlc.device)
        .bind(entity_uid)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }

    let mut prior = load_state_tx(tx, op.kind, entity_uid).await?;
    if prior.values().all(Value::is_null) {
        if let Some(op_prior) = &op.prior {
            prior = canonical_from_snapshot(op.kind, op_prior);
        }
    }
    let prior_json = serde_json::to_string(&prior).unwrap_or_else(|_| "{}".to_string());
    sqlx::query(
        "UPDATE sync_state_entities SET deleted = 1, deleted_wall = ?2,
         deleted_count = ?3, deleted_dev = ?4 WHERE kind = ?1 AND entity_uid = ?5",
    )
    .bind(op.kind.as_str())
    .bind(op.hlc.wall)
    .bind(op.hlc.counter as i64)
    .bind(&op.hlc.device)
    .bind(entity_uid)
    .execute(&mut **tx)
    .await?;

    let deleted_at = now_rfc3339();
    let expires = chrono::Utc::now() + chrono::Duration::days(TRASH_DAYS);
    sqlx::query(
        r#"
        INSERT INTO sync_trash
            (kind, entity_uid, book_uid, prior_json, deleted_wall, deleted_count,
             deleted_dev, deleted_at, expires_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(kind, entity_uid, deleted_wall, deleted_count, deleted_dev) DO NOTHING
        "#,
    )
    .bind(op.kind.as_str())
    .bind(entity_uid)
    .bind(book_uid)
    .bind(prior_json)
    .bind(op.hlc.wall)
    .bind(op.hlc.counter as i64)
    .bind(&op.hlc.device)
    .bind(deleted_at)
    .bind(expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

struct EntityRow {
    deleted: bool,
    hlc: Hlc,
    deleted_hlc: Option<Hlc>,
    restored_hlc: Option<Hlc>,
}

type EntityDbRow = (i64, i64, i64, String, i64, i64, String, i64, i64, String);

async fn load_entity(
    tx: &mut Transaction<'_, Sqlite>,
    kind: EntityKind,
    entity_uid: &str,
) -> Result<Option<EntityRow>, AppError> {
    let row: Option<EntityDbRow> = sqlx::query_as(
        "SELECT deleted, hlc_wall, hlc_counter, hlc_device,
                    deleted_wall, deleted_count, deleted_dev,
                    restored_wall, restored_count, restored_dev
             FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2",
    )
    .bind(kind.as_str())
    .bind(entity_uid)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(
        |(
            deleted,
            wall,
            counter,
            device,
            deleted_wall,
            deleted_count,
            deleted_dev,
            restored_wall,
            restored_count,
            restored_dev,
        )| EntityRow {
            deleted: deleted != 0,
            hlc: Hlc {
                wall,
                counter: counter as u32,
                device,
            },
            deleted_hlc: (deleted_wall != 0).then_some(Hlc {
                wall: deleted_wall,
                counter: deleted_count as u32,
                device: deleted_dev,
            }),
            restored_hlc: (restored_wall != 0).then_some(Hlc {
                wall: restored_wall,
                counter: restored_count as u32,
                device: restored_dev,
            }),
        },
    ))
}

pub async fn load_state(
    pool: &SqlitePool,
    kind: EntityKind,
    entity_uid: &str,
) -> Result<(State, bool), AppError> {
    let mut tx = pool.begin().await?;
    let state = load_state_tx(&mut tx, kind, entity_uid).await?;
    let deleted: Option<i64> = sqlx::query_scalar(
        "SELECT deleted FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2",
    )
    .bind(kind.as_str())
    .bind(entity_uid)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((state, deleted.unwrap_or(0) != 0))
}

async fn load_state_tx(
    tx: &mut Transaction<'_, Sqlite>,
    kind: EntityKind,
    entity_uid: &str,
) -> Result<State, AppError> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT field, value_json FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2",
    )
    .bind(kind.as_str())
    .bind(entity_uid)
    .fetch_all(&mut **tx)
    .await?;
    let mut state: BTreeMap<String, Value> = field_names(kind)
        .iter()
        .map(|field| ((*field).to_string(), Value::Null))
        .collect();
    for (field, json) in rows {
        if let Some(slot) = state.get_mut(&field) {
            *slot = serde_json::from_str(&json).unwrap_or(Value::Null);
        }
    }
    Ok(state)
}

/// Preserve a local edit that arrived after the entity was already deleted on
/// another machine. The tombstone still wins, but the text is not lost.
pub async fn record_tombstone_conflict(
    pool: &SqlitePool,
    kind: EntityKind,
    entity_uid: &str,
    loser: &State,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    let delete_hlc: Option<(i64, i64, String)> = sqlx::query_as(
        "SELECT deleted_wall, deleted_count, deleted_dev FROM sync_state_entities
         WHERE kind = ?1 AND entity_uid = ?2 AND deleted = 1",
    )
    .bind(kind.as_str())
    .bind(entity_uid)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((wall, counter, device)) = delete_hlc else {
        tx.commit().await?;
        return Ok(());
    };
    let loser = Value::Object(loser.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
    record_conflict(
        &mut tx,
        kind,
        entity_uid,
        "__deleted__",
        &Value::String("deleted".into()),
        &loser,
        &Hlc {
            wall,
            counter: counter as u32,
            device,
        },
        &Hlc::zero(),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn record_conflict(
    tx: &mut Transaction<'_, Sqlite>,
    kind: EntityKind,
    entity_uid: &str,
    field: &str,
    winner: &Value,
    loser: &Value,
    winner_hlc: &Hlc,
    loser_hlc: &Hlc,
) -> Result<(), AppError> {
    // Do not record a conflict when both sides say the same thing.
    if winner == loser {
        return Ok(());
    }
    let winner_text = serde_json::to_string(winner).unwrap_or_else(|_| "null".into());
    let loser_text = serde_json::to_string(loser).unwrap_or_else(|_| "null".into());
    let issue_key = format!("conflict:{}:{entity_uid}:{field}", kind.as_str());
    let detail = format!(
        "{} field {field}: kept {}, discarded {}",
        kind.as_str(),
        truncate(&winner_text, 1800),
        truncate(&loser_text, 1800)
    );
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM sync_issues WHERE issue_key = ?1 AND resolved_at IS NULL LIMIT 1",
    )
    .bind(&issue_key)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(id) = existing {
        sqlx::query(
            "UPDATE sync_issues SET detail = ?2,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        )
        .bind(id)
        .bind(&detail)
        .execute(&mut **tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO sync_issues (issue_key, kind, detail) VALUES (?1, 'conflict', ?2)",
        )
        .bind(&issue_key)
        .bind(&detail)
        .execute(&mut **tx)
        .await?;
    }
    sqlx::query(
        r#"
        INSERT INTO sync_conflicts
            (kind, entity_uid, field, winner_json, loser_json,
             winner_wall, winner_count, winner_dev,
             loser_wall, loser_count, loser_dev)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
    )
    .bind(kind.as_str())
    .bind(entity_uid)
    .bind(field)
    .bind(serde_json::to_string(winner).unwrap_or_else(|_| "null".into()))
    .bind(serde_json::to_string(loser).unwrap_or_else(|_| "null".into()))
    .bind(winner_hlc.wall)
    .bind(winner_hlc.counter as i64)
    .bind(&winner_hlc.device)
    .bind(loser_hlc.wall)
    .bind(loser_hlc.counter as i64)
    .bind(&loser_hlc.device)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn canonical_book_uid_tx(
    tx: &mut Transaction<'_, Sqlite>,
    uid: &str,
) -> Result<String, AppError> {
    let mut current = uid.to_string();
    for _ in 0..32 {
        let next: Option<String> =
            sqlx::query_scalar("SELECT winner FROM sync_book_merges WHERE loser = ?1")
                .bind(&current)
                .fetch_optional(&mut **tx)
                .await?;
        match next {
            Some(next) if next != current => current = next,
            _ => break,
        }
    }
    Ok(current)
}

async fn canonical_entity_uid_tx(
    tx: &mut Transaction<'_, Sqlite>,
    kind: EntityKind,
    uid: &str,
) -> Result<String, AppError> {
    let mut current = uid.to_string();
    for _ in 0..32 {
        let next: Option<String> = sqlx::query_scalar(
            "SELECT winner FROM sync_entity_merges WHERE kind = ?1 AND loser = ?2",
        )
        .bind(kind.as_str())
        .bind(&current)
        .fetch_optional(&mut **tx)
        .await?;
        match next {
            Some(next) if next != current => current = next,
            _ => break,
        }
    }
    Ok(current)
}

/// Project one entity's final mirror state into the local catalog. Collection
/// name collisions are resolved here because the local schema makes the name
/// unique.
pub async fn project(
    pool: &SqlitePool,
    folder_root: &std::path::Path,
    covers_dir: &std::path::Path,
    affected: &[Affected],
) -> Result<Vec<i64>, AppError> {
    let mut books = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in affected {
        if !seen.insert((item.kind, item.entity_uid.clone())) {
            continue;
        }
        if item.kind == EntityKind::BookIdentity {
            continue;
        }
        if item.kind == EntityKind::Collection {
            project_collection(pool, item).await?;
            continue;
        }
        let Some(book_uid) = &item.book_uid else {
            continue;
        };
        let Some(book_id) = durable_record_id(pool, book_uid).await? else {
            continue;
        };
        let (state, deleted) = load_state(pool, item.kind, &item.entity_uid).await?;
        match item.kind {
            EntityKind::Annotation => {
                project_annotation(pool, book_id, item, &state, deleted).await?
            }
            EntityKind::Progress => project_progress(pool, book_id, &state, deleted).await?,
            EntityKind::Metadata | EntityKind::Opened => {
                if item.kind == EntityKind::Metadata {
                    project_metadata(pool, book_id, folder_root, covers_dir, &state).await?
                } else {
                    project_opened(pool, book_id, &state).await?
                }
            }
            EntityKind::Membership => project_membership(pool, item, &state).await?,
            EntityKind::Collection | EntityKind::BookIdentity => {}
        }
        books.push(book_id);
    }
    books.sort_unstable();
    books.dedup();
    Ok(books)
}

/// Project every shared entity attached to a book. Used when a newly imported
/// book binds to a portable id: state that arrived before the file existed is
/// applied in one step.
pub async fn project_book(
    pool: &SqlitePool,
    book_uid: &str,
    folder_root: &std::path::Path,
    covers_dir: &std::path::Path,
) -> Result<Vec<i64>, AppError> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT kind, entity_uid, book_uid FROM sync_state_entities WHERE book_uid = ?1",
    )
    .bind(book_uid)
    .fetch_all(pool)
    .await?;
    let affected: Vec<Affected> = rows
        .into_iter()
        .filter_map(|(kind, entity_uid, book_uid)| {
            EntityKind::parse(&kind).map(|kind| Affected {
                kind,
                entity_uid,
                book_uid,
            })
        })
        .collect();
    project(pool, folder_root, covers_dir, &affected).await
}

/// The public numeric id of a durable book.
async fn durable_record_id(pool: &SqlitePool, book_uid: &str) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM book_records WHERE uid = ?1")
        .bind(book_uid)
        .fetch_optional(pool)
        .await?;
    Ok(id)
}

async fn project_annotation(
    pool: &SqlitePool,
    book_id: i64,
    item: &Affected,
    state: &State,
    deleted: bool,
) -> Result<(), AppError> {
    if deleted {
        sqlx::query("DELETE FROM annotations WHERE sync_uid = ?1")
            .bind(&item.entity_uid)
            .execute(pool)
            .await?;
        return Ok(());
    }
    let kind = state
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("bookmark");
    sqlx::query(
        r#"
        INSERT INTO annotations
            (book_uid, sync_uid, kind, cfi, chapter_href, page_number, page_fraction,
             text, color, geometry, note, label, created_at, modified_at)
        VALUES ((SELECT uid FROM book_records WHERE id = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                COALESCE(?13, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(sync_uid) DO UPDATE SET
            book_uid = excluded.book_uid,
            kind = excluded.kind,
            cfi = excluded.cfi,
            chapter_href = excluded.chapter_href,
            page_number = excluded.page_number,
            page_fraction = excluded.page_fraction,
            text = excluded.text,
            color = excluded.color,
            geometry = excluded.geometry,
            note = excluded.note,
            label = excluded.label,
            modified_at = excluded.modified_at
        "#,
    )
    .bind(book_id)
    .bind(&item.entity_uid)
    .bind(kind)
    .bind(string_or_none(state, "cfi"))
    .bind(string_or_none(state, "chapter_href"))
    .bind(integer_or_none(state, "page_number"))
    .bind(number_or_none(state, "page_fraction"))
    .bind(string_or_none(state, "text"))
    .bind(string_or_none(state, "color"))
    .bind(string_or_none(state, "geometry"))
    .bind(string_or_none(state, "note"))
    .bind(string_or_none(state, "label"))
    .bind(string_or_none(state, "created_at"))
    .execute(pool)
    .await?;
    Ok(())
}

async fn project_progress(
    pool: &SqlitePool,
    book_id: i64,
    state: &State,
    deleted: bool,
) -> Result<(), AppError> {
    if deleted {
        sqlx::query(
            "DELETE FROM reading_progress \
             WHERE book_uid = (SELECT uid FROM book_records WHERE id = ?1)",
        )
        .bind(book_id)
        .execute(pool)
        .await?;
        return Ok(());
    }
    sqlx::query(
        r#"
        INSERT INTO reading_progress
            (book_uid, chapter_href, cfi, character_offset, page_number, scroll_offset,
             progress_percent, locator, progression, locations, engine, schema_version)
        VALUES ((SELECT uid FROM book_records WHERE id = ?1),
                ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(book_uid) DO UPDATE SET
            chapter_href = excluded.chapter_href,
            cfi = excluded.cfi,
            character_offset = excluded.character_offset,
            page_number = excluded.page_number,
            scroll_offset = excluded.scroll_offset,
            progress_percent = excluded.progress_percent,
            locator = excluded.locator,
            progression = excluded.progression,
            locations = excluded.locations,
            engine = excluded.engine,
            schema_version = excluded.schema_version,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
    )
    .bind(book_id)
    .bind(string_or_none(state, "chapter_href"))
    .bind(string_or_none(state, "cfi"))
    .bind(integer_or_none(state, "character_offset"))
    .bind(integer_or_none(state, "page_number"))
    .bind(number_or_none(state, "scroll_offset"))
    .bind(number_or_none(state, "progress_percent"))
    .bind(string_or_none(state, "locator"))
    .bind(number_or_none(state, "progression"))
    .bind(string_or_none(state, "locations"))
    .bind(string_or_none(state, "engine"))
    .bind(integer_or_none(state, "schema_version"))
    .execute(pool)
    .await?;
    Ok(())
}

async fn project_opened(pool: &SqlitePool, book_id: i64, state: &State) -> Result<(), AppError> {
    sqlx::query("UPDATE book_records SET last_opened_at = ?2 WHERE id = ?1")
        .bind(book_id)
        .bind(string_or_none(state, "last_opened_at"))
        .execute(pool)
        .await?;
    Ok(())
}

async fn project_metadata(
    pool: &SqlitePool,
    book_id: i64,
    folder_root: &std::path::Path,
    covers_dir: &std::path::Path,
    state: &State,
) -> Result<(), AppError> {
    let cover_name = string_or_none(state, "cover_path");
    let cover_path = match cover_name {
        Some(name) => {
            if super::store::apply_cover_blob(folder_root, covers_dir, &name)? {
                Some(covers_dir.join(&name).to_string_lossy().into_owned())
            } else {
                None
            }
        }
        None => None,
    };
    let overrides = crate::repository::metadata::OverrideRow {
        title: string_or_none(state, "title"),
        subtitle: string_or_none(state, "subtitle"),
        publisher: string_or_none(state, "publisher"),
        language: string_or_none(state, "language"),
        isbn: string_or_none(state, "isbn"),
        description: string_or_none(state, "description"),
        publication_date: string_or_none(state, "publication_date"),
        series: string_or_none(state, "series"),
        series_index: number_or_none(state, "series_index"),
        cover_path,
        authors_customized: state
            .get("authors_customized")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        subjects_customized: state
            .get("subjects_customized")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    crate::services::metadata::apply_synced_overrides(
        pool,
        book_id,
        &overrides,
        &string_list(state, "authors"),
        &string_list(state, "subjects"),
    )
    .await
}

async fn project_membership(
    pool: &SqlitePool,
    item: &Affected,
    state: &State,
) -> Result<(), AppError> {
    let Some((collection_uid, book_uid)) = item.entity_uid.split_once(':') else {
        return Ok(());
    };
    let present = state
        .get("present")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if durable_record_id(pool, book_uid).await?.is_none() {
        return Ok(());
    }
    let Some(collection_id) = local_collection_id(pool, collection_uid).await? else {
        return Ok(());
    };
    if present {
        sqlx::query(
            "INSERT OR IGNORE INTO book_collections (book_uid, collection_id) VALUES (?1, ?2)",
        )
        .bind(book_uid)
        .bind(collection_id)
        .execute(pool)
        .await?;
    } else {
        sqlx::query("DELETE FROM book_collections WHERE book_uid = ?1 AND collection_id = ?2")
            .bind(book_uid)
            .bind(collection_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn project_collection(pool: &SqlitePool, item: &Affected) -> Result<(), AppError> {
    let (state, deleted) = load_state(pool, EntityKind::Collection, &item.entity_uid).await?;
    if deleted {
        sqlx::query("DELETE FROM collections WHERE sync_uid = ?1")
            .bind(&item.entity_uid)
            .execute(pool)
            .await?;
        return Ok(());
    }
    let Some(name) = state.get("name").and_then(Value::as_str) else {
        return Ok(());
    };
    let created_at = state
        .get("created_at")
        .and_then(Value::as_str)
        .unwrap_or("1970-01-01T00:00:00.000Z");

    let by_uid: Option<i64> = sqlx::query_scalar("SELECT id FROM collections WHERE sync_uid = ?1")
        .bind(&item.entity_uid)
        .fetch_optional(pool)
        .await?;
    if let Some(id) = by_uid {
        sqlx::query("UPDATE collections SET name = ?2, created_at = ?3 WHERE id = ?1")
            .bind(id)
            .bind(name)
            .bind(created_at)
            .execute(pool)
            .await?;
        project_collection_memberships(pool, &item.entity_uid).await?;
        return Ok(());
    }

    let same_name: Option<(i64, String)> =
        sqlx::query_as("SELECT id, COALESCE(sync_uid, '') FROM collections WHERE name = ?1")
            .bind(name)
            .fetch_optional(pool)
            .await?;
    if let Some((id, local_uid)) = same_name {
        let canonical = if local_uid.is_empty() {
            item.entity_uid.clone()
        } else if local_uid <= item.entity_uid {
            local_uid.clone()
        } else {
            item.entity_uid.clone()
        };
        if !local_uid.is_empty() && local_uid != canonical {
            super::identity::merge_collection_identity(pool, &local_uid, &canonical).await?;
        }
        if canonical != item.entity_uid {
            super::identity::merge_collection_identity(pool, &item.entity_uid, &canonical).await?;
        }
        // The surviving row keeps the local id, so memberships keep pointing
        // at it; only the portable uid and display fields change.
        sqlx::query(
            "UPDATE collections SET sync_uid = ?2, name = ?3, created_at = ?4 WHERE id = ?1",
        )
        .bind(id)
        .bind(&canonical)
        .bind(name)
        .bind(created_at)
        .execute(pool)
        .await?;
        project_collection_memberships(pool, &canonical).await?;
        return Ok(());
    }

    sqlx::query("INSERT INTO collections (sync_uid, name, created_at) VALUES (?1, ?2, ?3)")
        .bind(&item.entity_uid)
        .bind(name)
        .bind(created_at)
        .execute(pool)
        .await?;
    project_collection_memberships(pool, &item.entity_uid).await?;
    Ok(())
}

async fn project_collection_memberships(
    pool: &SqlitePool,
    collection_uid: &str,
) -> Result<(), AppError> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT entity_uid FROM sync_state_entities
         WHERE kind = 'membership' AND entity_uid LIKE ?1",
    )
    .bind(format!("{collection_uid}:%"))
    .fetch_all(pool)
    .await?;
    for entity_uid in rows {
        let (state, deleted) = load_state(pool, EntityKind::Membership, &entity_uid).await?;
        if deleted {
            continue;
        }
        project_membership(
            pool,
            &Affected {
                kind: EntityKind::Membership,
                entity_uid,
                book_uid: None,
            },
            &state,
        )
        .await?;
    }
    Ok(())
}

async fn local_collection_id(
    pool: &SqlitePool,
    collection_uid: &str,
) -> Result<Option<i64>, AppError> {
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM collections WHERE sync_uid = ?1")
        .bind(collection_uid)
        .fetch_optional(pool)
        .await?;
    Ok(id)
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut text: String = value.chars().take(max_chars).collect();
    if text.len() < value.len() {
        text.push('…');
    }
    text
}

fn string_or_none(state: &State, field: &str) -> Option<String> {
    state
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn integer_or_none(state: &State, field: &str) -> Option<i64> {
    state.get(field).and_then(Value::as_i64)
}

fn number_or_none(state: &State, field: &str) -> Option<f64> {
    state.get(field).and_then(Value::as_f64)
}

fn string_list(state: &State, field: &str) -> Vec<String> {
    state
        .get(field)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Build a delete op from the current mirror state; used by trash restore's
/// inverse and by tests.
pub fn prior_from_state(state: &State) -> Map<String, Value> {
    state.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::model::{Hlc, Op, OP_SCHEMA};
    use serde_json::json;

    fn op(kind: EntityKind, uid: &str, book: &str, fields: Value) -> Op {
        Op {
            schema: OP_SCHEMA,
            op_id: format!("{:032x}", rand_id()),
            device_id: "b".repeat(32),
            hlc: Hlc {
                wall: 100,
                counter: 0,
                device: "b".repeat(32),
            },
            kind,
            entity_uid: uid.into(),
            book_uid: Some(book.into()),
            deleted: false,
            restore: false,
            fields: fields.as_object().unwrap().clone(),
            prior: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    fn rand_id() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    #[tokio::test]
    async fn annotation_fields_merge_independently() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let uid = "a".repeat(32);
        let mut first = op(
            EntityKind::Annotation,
            &uid,
            &book,
            json!({"kind": "highlight", "text": "passage", "note": "one"}),
        );
        first.hlc.wall = 100;
        apply_op(&pool, &first, "a.json").await.unwrap();

        let mut second = op(EntityKind::Annotation, &uid, &book, json!({"note": "two"}));
        second.hlc.wall = 101;
        apply_op(&pool, &second, "b.json").await.unwrap();

        let (state, deleted) = load_state(&pool, EntityKind::Annotation, &uid)
            .await
            .unwrap();
        assert!(!deleted);
        assert_eq!(state.get("note"), Some(&json!("two")));
        assert_eq!(state.get("text"), Some(&json!("passage")));
    }

    #[tokio::test]
    async fn older_field_does_not_overwrite_and_is_kept_as_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let uid = "c".repeat(32);
        let mut newer = op(
            EntityKind::Annotation,
            &uid,
            &book,
            json!({"note": "newer"}),
        );
        newer.hlc.wall = 200;
        apply_op(&pool, &newer, "a.json").await.unwrap();
        let mut older = op(
            EntityKind::Annotation,
            &uid,
            &book,
            json!({"note": "older"}),
        );
        older.hlc.wall = 100;
        apply_op(&pool, &older, "b.json").await.unwrap();
        let (state, _) = load_state(&pool, EntityKind::Annotation, &uid)
            .await
            .unwrap();
        assert_eq!(state.get("note"), Some(&json!("newer")));
        let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(conflicts, 1);
    }

    #[tokio::test]
    async fn delete_wins_and_restore_is_explicit() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let uid = "d".repeat(32);
        let mut create = op(
            EntityKind::Annotation,
            &uid,
            &book,
            json!({"kind": "bookmark", "cfi": "x", "note": "keep"}),
        );
        create.hlc.wall = 100;
        apply_op(&pool, &create, "a.json").await.unwrap();

        let mut delete = op(EntityKind::Annotation, &uid, &book, json!({}));
        delete.deleted = true;
        delete.fields = Map::new();
        delete.hlc.wall = 200;
        apply_op(&pool, &delete, "b.json").await.unwrap();
        let (_, deleted) = load_state(&pool, EntityKind::Annotation, &uid)
            .await
            .unwrap();
        assert!(deleted);

        let mut concurrent = op(
            EntityKind::Annotation,
            &uid,
            &book,
            json!({"note": "edited elsewhere"}),
        );
        concurrent.hlc.wall = 300;
        apply_op(&pool, &concurrent, "c.json").await.unwrap();
        let (_, deleted) = load_state(&pool, EntityKind::Annotation, &uid)
            .await
            .unwrap();
        assert!(deleted, "a concurrent edit must not resurrect a delete");

        let mut restore = op(
            EntityKind::Annotation,
            &uid,
            &book,
            json!({"kind": "bookmark", "cfi": "x", "note": "back"}),
        );
        restore.restore = true;
        restore.hlc.wall = 400;
        apply_op(&pool, &restore, "d.json").await.unwrap();
        let (state, deleted) = load_state(&pool, EntityKind::Annotation, &uid)
            .await
            .unwrap();
        assert!(!deleted);
        assert_eq!(state.get("note"), Some(&json!("back")));
    }

    #[tokio::test]
    async fn progress_replaces_the_whole_locator() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let uid = "e".repeat(32);
        let all = |page: u64, cfi: &str| {
            json!({
                "chapter_href": "c.xhtml",
                "cfi": cfi,
                "character_offset": 0,
                "page_number": page,
                "scroll_offset": 0.0,
                "progress_percent": 10.0,
                "locator": "x",
                "progression": 0.1,
                "locations": "{}",
                "engine": "readium",
                "schema_version": 2
            })
        };
        let mut first = op(EntityKind::Progress, &uid, &book, all(1, "a"));
        first.hlc.wall = 100;
        apply_op(&pool, &first, "a.json").await.unwrap();
        let mut second = op(EntityKind::Progress, &uid, &book, all(2, "b"));
        second.hlc.wall = 101;
        apply_op(&pool, &second, "b.json").await.unwrap();
        let (state, _) = load_state(&pool, EntityKind::Progress, &uid).await.unwrap();
        assert_eq!(state.get("page_number"), Some(&json!(2)));
        assert_eq!(state.get("cfi"), Some(&json!("b")));
    }

    async fn create_book(pool: &SqlitePool) -> String {
        let book_id = crate::repository::books::upsert_book(
            pool,
            &crate::domain::NewBook {
                path: "/tmp/sync-test.epub".into(),
                title: "Sync test".into(),
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
        .unwrap()
        .0;
        let uid = "f".repeat(32);
        sqlx::query(
            "INSERT INTO sync_book_bindings (book_id, book_uid, content_hash, hashed_size, hashed_mtime)
             VALUES (?1, ?2, 'x', 0, 0)",
        )
        .bind(book_id)
        .bind(&uid)
        .execute(pool)
        .await
        .unwrap();
        uid
    }
}
