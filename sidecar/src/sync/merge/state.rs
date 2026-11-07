//! The shared-state merge: last-writer-wins per field or per entity, and
//! delete-wins tombstones with an explicit restore path.

use std::collections::BTreeMap;

use serde_json::Value;
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppError;
use crate::sync::clock::now_rfc3339;
use crate::sync::model::{
    canonical_from_snapshot, field_names, EntityKind, Hlc, MergeMode, Op, State, TRASH_DAYS,
};

use super::conflict::record_conflict;
use super::Affected;

pub(super) async fn apply_state_op(
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
        // A restore closes the local Recently deleted entry on every device,
        // not only on the one that picked it. The row is local trash, so this
        // never travels in the operation.
        sqlx::query(
            "UPDATE sync_trash SET restored_at = ?3
             WHERE kind = ?1 AND entity_uid = ?2 AND restored_at IS NULL",
        )
        .bind(op.kind.as_str())
        .bind(entity_uid)
        .bind(now_rfc3339())
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

pub(super) async fn load_state_tx(
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
