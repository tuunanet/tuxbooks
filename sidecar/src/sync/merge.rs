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

use super::clock::{device_id, now_rfc3339, observe_hlc};
use super::identity::merge_book_identity;
use super::model::{
    canonical_from_snapshot, conflict_issue_key, field_names, EntityKind, Hlc, MergeMode, Op,
    State, TRASH_DAYS,
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

    if op.kind == EntityKind::Book {
        let affected = apply_book(pool, op).await?;
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

    // A whole-book Forget wins over any in-flight edit. The losing value is
    // not resurrected; the user asked to erase the identity.
    if let Some(book_uid) = &op.book_uid {
        let canonical = super::identity::canonical_book_uid(pool, book_uid).await?;
        if super::identity::forgotten_replacement(pool, &canonical)
            .await?
            .is_some()
        {
            sqlx::query(
                "INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, file_name)
                 VALUES (?1, ?2, ?3)",
            )
            .bind(&op.op_id)
            .bind(&op.device_id)
            .bind(file_name)
            .execute(pool)
            .await?;
            return Ok(Vec::new());
        }
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
    let incoming = match super::identity::forgotten_replacement(pool, &incoming).await? {
        // The old identity is dead. Its replacement is the live candidate.
        Some(Some(replacement)) => replacement,
        // Forgotten without a fresh identity: never republish the alias.
        Some(None) => return Ok(Vec::new()),
        None => incoming,
    };
    let existing: Option<String> =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(content_hash)
            .fetch_optional(pool)
            .await?;
    let existing = match existing {
        Some(existing) => match super::identity::forgotten_replacement(pool, &existing).await? {
            Some(Some(replacement)) => Some(replacement),
            Some(None) => None,
            None => Some(super::identity::canonical_book_uid(pool, &existing).await?),
        },
        None => None,
    };
    let canonical = match existing {
        Some(existing) => {
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

struct BookTrashRow {
    replacement: Option<String>,
    snapshot: Option<String>,
    deleted: Hlc,
    restored: Option<Hlc>,
}

/// Whether a book uid currently has an open shared Forget and whether its
/// trash entry is already closed. Capture uses this to drop projection echoes.
pub async fn book_lifecycle_state(
    pool: &SqlitePool,
    book_uid: &str,
) -> Result<(bool, bool), AppError> {
    let deleted: Option<i64> = sqlx::query_scalar(
        "SELECT deleted FROM sync_state_entities WHERE kind = 'book' AND entity_uid = ?1",
    )
    .bind(book_uid)
    .fetch_optional(pool)
    .await?;
    let restored: Option<Option<String>> =
        sqlx::query_scalar("SELECT restored_at FROM sync_book_trash WHERE book_uid = ?1")
            .bind(book_uid)
            .fetch_optional(pool)
            .await?;
    Ok((deleted.unwrap_or(0) != 0, restored.flatten().is_some()))
}

async fn load_book_trash(
    tx: &mut Transaction<'_, Sqlite>,
    book_uid: &str,
) -> Result<Option<BookTrashRow>, AppError> {
    type Row = (
        Option<String>,
        Option<String>,
        i64,
        i64,
        String,
        i64,
        i64,
        String,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT replacement_book_uid, snapshot_json,
                deleted_wall, deleted_count, deleted_dev,
                restored_wall, restored_count, restored_dev
         FROM sync_book_trash WHERE book_uid = ?1",
    )
    .bind(book_uid)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(
        |(
            replacement,
            snapshot,
            deleted_wall,
            deleted_count,
            deleted_dev,
            restored_wall,
            restored_count,
            restored_dev,
        )| BookTrashRow {
            replacement,
            snapshot,
            deleted: Hlc {
                wall: deleted_wall,
                counter: deleted_count as u32,
                device: deleted_dev,
            },
            restored: (restored_wall != 0).then_some(Hlc {
                wall: restored_wall,
                counter: restored_count as u32,
                device: restored_dev,
            }),
        },
    ))
}

/// Apply a whole-book Forget, restore, or discard. A Forget keeps the
/// per-entity mirror rows under the old uid; the book tombstone is what makes
/// them invisible, so no annotation tombstone is invented.
async fn apply_book(pool: &SqlitePool, op: &Op) -> Result<Vec<Affected>, AppError> {
    let book_uid = super::identity::canonical_book_uid(pool, &op.entity_uid).await?;
    let mut tx = pool.begin().await?;
    let existing = load_book_trash(&mut tx, &book_uid).await?;
    let now = now_rfc3339();
    let mut restore_without_snapshot = false;

    if op.deleted {
        let replacement = op
            .prior
            .as_ref()
            .and_then(|prior| prior.get("replacement_book_uid"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let snapshot = op
            .prior
            .as_ref()
            .and_then(|prior| prior.get("snapshot"))
            .and_then(Value::as_str)
            .map(str::to_string);

        if let Some(existing) = &existing {
            if existing.deleted >= op.hlc {
                tx.commit().await?;
                return Ok(Vec::new());
            }
            if existing
                .restored
                .as_ref()
                .is_some_and(|restored| restored >= &op.hlc)
            {
                tx.commit().await?;
                return Ok(Vec::new());
            }
        }

        let expires = (chrono::Utc::now() + chrono::Duration::days(TRASH_DAYS))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query(
            r#"
            INSERT INTO sync_book_trash
                (book_uid, replacement_book_uid, snapshot_json, deleted_wall,
                 deleted_count, deleted_dev, deleted_at, expires_at,
                 restored_at, discarded, restored_wall, restored_count, restored_dev)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 0, 0, 0, '')
            ON CONFLICT(book_uid) DO UPDATE SET
                replacement_book_uid = excluded.replacement_book_uid,
                snapshot_json = COALESCE(excluded.snapshot_json, sync_book_trash.snapshot_json),
                deleted_wall = excluded.deleted_wall,
                deleted_count = excluded.deleted_count,
                deleted_dev = excluded.deleted_dev,
                deleted_at = excluded.deleted_at,
                expires_at = excluded.expires_at,
                restored_at = NULL,
                discarded = 0,
                restored_wall = 0,
                restored_count = 0,
                restored_dev = ''
            "#,
        )
        .bind(&book_uid)
        .bind(&replacement)
        .bind(&snapshot)
        .bind(op.hlc.wall)
        .bind(op.hlc.counter as i64)
        .bind(&op.hlc.device)
        .bind(&now)
        .bind(&expires)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO sync_state_entities
                (kind, entity_uid, book_uid, hlc_wall, hlc_counter, hlc_device,
                 deleted, deleted_wall, deleted_count, deleted_dev)
            VALUES ('book', ?1, ?1, ?2, ?3, ?4, 1, ?2, ?3, ?4)
            ON CONFLICT(kind, entity_uid) DO UPDATE SET
                book_uid = excluded.book_uid,
                hlc_wall = excluded.hlc_wall,
                hlc_counter = excluded.hlc_counter,
                hlc_device = excluded.hlc_device,
                deleted = 1,
                deleted_wall = excluded.deleted_wall,
                deleted_count = excluded.deleted_count,
                deleted_dev = excluded.deleted_dev
            "#,
        )
        .bind(&book_uid)
        .bind(op.hlc.wall)
        .bind(op.hlc.counter as i64)
        .bind(&op.hlc.device)
        .execute(&mut *tx)
        .await?;

        sqlx::query("DELETE FROM sync_book_aliases WHERE book_uid = ?1")
            .bind(&book_uid)
            .execute(&mut *tx)
            .await?;
        if let Some(replacement) = &replacement {
            for hash in snapshot_aliases(snapshot.as_deref()) {
                sqlx::query(
                    "INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)
                     ON CONFLICT(content_hash) DO UPDATE SET book_uid = excluded.book_uid",
                )
                .bind(hash)
                .bind(replacement)
                .execute(&mut *tx)
                .await?;
            }
        }
    } else {
        let explicit_discard = op
            .fields
            .get("discarded")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let Some(existing) = &existing {
            if existing.deleted > op.hlc {
                tx.commit().await?;
                return Ok(Vec::new());
            }
            if existing
                .restored
                .as_ref()
                .is_some_and(|restored| restored > &op.hlc)
            {
                tx.commit().await?;
                return Ok(Vec::new());
            }
        }
        let replacement = op
            .fields
            .get("replacement_book_uid")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| existing.as_ref().and_then(|row| row.replacement.clone()));
        let snapshot = op
            .fields
            .get("snapshot")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| existing.as_ref().and_then(|row| row.snapshot.clone()));
        // A restore with no snapshot cannot recreate the book. Keep the
        // tombstone and record the failure instead of pretending it worked.
        let discarded = explicit_discard || snapshot.is_none();
        restore_without_snapshot = !explicit_discard && snapshot.is_none();

        sqlx::query(
            r#"
            INSERT INTO sync_book_trash
                (book_uid, replacement_book_uid, snapshot_json, deleted_wall,
                 deleted_count, deleted_dev, deleted_at, expires_at,
                 restored_at, discarded, restored_wall, restored_count, restored_dev)
            VALUES (?1, ?2, ?3, ?4, ?7, ?8, ?5, ?5, ?5, ?6, ?4, ?7, ?8)
            ON CONFLICT(book_uid) DO UPDATE SET
                replacement_book_uid = COALESCE(excluded.replacement_book_uid,
                                                sync_book_trash.replacement_book_uid),
                restored_at = excluded.restored_at,
                discarded = excluded.discarded,
                restored_wall = excluded.restored_wall,
                restored_count = excluded.restored_count,
                restored_dev = excluded.restored_dev
            "#,
        )
        .bind(&book_uid)
        .bind(&replacement)
        .bind(&snapshot)
        .bind(op.hlc.wall)
        .bind(&now)
        .bind(i64::from(discarded))
        .bind(op.hlc.counter as i64)
        .bind(&op.hlc.device)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO sync_state_entities
                (kind, entity_uid, book_uid, hlc_wall, hlc_counter, hlc_device,
                 deleted, restored_wall, restored_count, restored_dev)
            VALUES ('book', ?1, ?1, ?2, ?3, ?4, ?5, ?2, ?3, ?4)
            ON CONFLICT(kind, entity_uid) DO UPDATE SET
                book_uid = excluded.book_uid,
                hlc_wall = excluded.hlc_wall,
                hlc_counter = excluded.hlc_counter,
                hlc_device = excluded.hlc_device,
                deleted = excluded.deleted,
                restored_wall = excluded.restored_wall,
                restored_count = excluded.restored_count,
                restored_dev = excluded.restored_dev
            "#,
        )
        .bind(&book_uid)
        .bind(op.hlc.wall)
        .bind(op.hlc.counter as i64)
        .bind(&op.hlc.device)
        .bind(i64::from(discarded))
        .execute(&mut *tx)
        .await?;

        if !discarded {
            if let Some(replacement) = &replacement {
                // The fresh identity is discarded with the restore; its
                // aliases (including a post-Forget metadata rewrite) must not
                // outlive it.
                sqlx::query("DELETE FROM sync_book_aliases WHERE book_uid = ?1")
                    .bind(replacement)
                    .execute(&mut *tx)
                    .await?;
            }
            for hash in snapshot_aliases(snapshot.as_deref()) {
                sqlx::query(
                    "INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)
                     ON CONFLICT(content_hash) DO UPDATE SET book_uid = excluded.book_uid",
                )
                .bind(hash)
                .bind(&book_uid)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    tx.commit().await?;
    if restore_without_snapshot {
        super::identity::record_issue(
            pool,
            &format!("restore-snapshot-missing:{book_uid}"),
            "book_snapshot_missing",
            "a shared restore arrived without a usable snapshot; the book stays forgotten on this machine",
            None,
        )
        .await?;
    }
    Ok(vec![Affected {
        kind: EntityKind::Book,
        entity_uid: book_uid.clone(),
        book_uid: Some(book_uid),
    }])
}

fn snapshot_aliases(snapshot: Option<&str>) -> Vec<String> {
    let Some(snapshot) = snapshot else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(snapshot) else {
        return Vec::new();
    };
    value
        .get("aliases")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|hash| super::model::is_hex_hash(hash))
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
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
    let loser_device = device_id(pool).await?;
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
    // The local edit is the loser here and has no operation clock of its own
    // yet. Record the writing device and a current wall time so the review row
    // names who made it, without taking an HLC that would reorder the merge.
    let loser_hlc = Hlc {
        wall: chrono::Utc::now().timestamp_millis(),
        counter: 0,
        device: loser_device,
    };
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
        &loser_hlc,
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
    let issue_key = conflict_issue_key(kind, entity_uid, field);
    let detail = format!(
        "{} field {field}: kept {}, discarded {}",
        kind.as_str(),
        truncate(&winner_text, 1800),
        truncate(&loser_text, 1800)
    );
    // Progress and other additive state never ask the user for a choice. Keep
    // the row for diagnostics, but do not open a review issue for it.
    if kind != EntityKind::Progress {
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
        if item.kind == EntityKind::Book {
            if let Some(id) = project_book_lifecycle(pool, &item.entity_uid).await? {
                books.push(id);
            }
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
            EntityKind::Collection | EntityKind::BookIdentity | EntityKind::Book => {}
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
    if super::identity::forgotten_replacement(pool, book_uid)
        .await?
        .is_some()
    {
        return Ok(Vec::new());
    }
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

/// Project a whole-book Forget, restore, or discard into the local durable
/// tables. The book-level mirror row is authoritative; a projection failure
/// becomes a visible Sync issue instead of silently dropping the snapshot.
async fn project_book_lifecycle(
    pool: &SqlitePool,
    book_uid: &str,
) -> Result<Option<i64>, AppError> {
    type LifecycleRow = (Option<String>, Option<String>, Option<String>, i64);
    let row: Option<LifecycleRow> = sqlx::query_as(
        "SELECT replacement_book_uid, snapshot_json, restored_at, discarded
         FROM sync_book_trash WHERE book_uid = ?1",
    )
    .bind(book_uid)
    .fetch_optional(pool)
    .await?;
    let Some((replacement, snapshot, restored_at, discarded)) = row else {
        return Ok(None);
    };
    let result = if restored_at.is_none() {
        crate::repository::lifecycle::apply_remote_forget(
            pool,
            book_uid,
            replacement.as_deref(),
            snapshot.as_deref(),
        )
        .await
    } else if discarded != 0 {
        crate::repository::lifecycle::apply_remote_discard(pool, book_uid).await
    } else {
        crate::repository::lifecycle::apply_remote_restore(pool, book_uid, snapshot.as_deref())
            .await
    };
    match result {
        Ok(id) => Ok(id),
        Err(err) => {
            super::identity::record_issue(
                pool,
                &format!("book-lifecycle:{book_uid}"),
                "book_lifecycle_failed",
                &format!("could not apply the shared change for forgotten book {book_uid}: {err}"),
                None,
            )
            .await?;
            Ok(None)
        }
    }
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

    #[test]
    fn snapshot_aliases_keeps_only_full_hex_hashes() {
        let hash = "a".repeat(64);
        let snapshot = json!({"aliases": [hash.clone(), "short", 7, "A".repeat(64)]}).to_string();
        assert_eq!(snapshot_aliases(Some(&snapshot)), vec![hash]);
        assert!(snapshot_aliases(None).is_empty());
        assert!(snapshot_aliases(Some("{not json")).is_empty());
        assert!(snapshot_aliases(Some(r#"{"aliases":"not-a-list"}"#)).is_empty());
    }

    #[test]
    fn truncate_marks_a_shortened_value() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }

    async fn forget_book(pool: &SqlitePool, uid: &str, replacement: Option<&str>) {
        sqlx::query(
            "INSERT INTO sync_book_trash
                (book_uid, replacement_book_uid, snapshot_json, deleted_wall,
                 deleted_count, deleted_dev, deleted_at, expires_at)
             VALUES (?1, ?2, NULL, 50, 0, 'other', '2026-01-01T00:00:00.000Z',
                     '2999-01-01T00:00:00.000Z')",
        )
        .bind(uid)
        .bind(replacement)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn durable_book(pool: &SqlitePool, path: &std::path::Path) -> (String, i64) {
        std::fs::write(path, b"merge test bytes").unwrap();
        crate::repository::books::upsert_book(
            pool,
            &crate::domain::NewBook {
                path: path.to_string_lossy().into_owned(),
                title: "Merge test".into(),
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
                file_size: 15,
                file_mtime: 0,
            },
        )
        .await
        .unwrap();
        sqlx::query_as("SELECT uid, id FROM book_records LIMIT 1")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn put_state(pool: &SqlitePool, kind: EntityKind, uid: &str, fields: &[(&str, Value)]) {
        sqlx::query(
            "INSERT INTO sync_state_entities (kind, entity_uid) VALUES (?1, ?2)
             ON CONFLICT(kind, entity_uid) DO NOTHING",
        )
        .bind(kind.as_str())
        .bind(uid)
        .execute(pool)
        .await
        .unwrap();
        for (field, value) in fields {
            sqlx::query(
                "INSERT INTO sync_state_fields
                    (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
                 VALUES (?1, ?2, ?3, ?4, 1, 0, 'other')
                 ON CONFLICT(kind, entity_uid, field) DO UPDATE SET
                    value_json = excluded.value_json",
            )
            .bind(kind.as_str())
            .bind(uid)
            .bind(field)
            .bind(serde_json::to_string(value).unwrap())
            .execute(pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn an_identity_op_requires_a_hash_and_respects_a_forgotten_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;

        let missing = op(EntityKind::BookIdentity, &book, &book, json!({}));
        let err = apply_op(&pool, &missing, "a.json").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");

        // Forgotten without a replacement: never republish the alias.
        let dead = "1".repeat(32);
        forget_book(&pool, &dead, None).await;
        let op_dead = op(
            EntityKind::BookIdentity,
            &dead,
            &dead,
            json!({"content_hash": "d".repeat(64)}),
        );
        assert!(apply_op(&pool, &op_dead, "b.json")
            .await
            .unwrap()
            .is_empty());
        let aliases: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_aliases")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(aliases, 0);

        // Forgotten with a replacement: the alias follows the live identity.
        let old = "2".repeat(32);
        let fresh = "3".repeat(32);
        forget_book(&pool, &old, Some(&fresh)).await;
        let hash = "e".repeat(64);
        let op_live = op(
            EntityKind::BookIdentity,
            &old,
            &old,
            json!({"content_hash": hash}),
        );
        let affected = apply_op(&pool, &op_live, "c.json").await.unwrap();
        assert_eq!(affected.len(), 1);
        assert_eq!(affected[0].entity_uid, fresh);
        let owner: String =
            sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
                .bind(&hash)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(owner, fresh);
    }

    #[tokio::test]
    async fn a_book_forget_restore_and_discard_move_the_aliases_and_respect_older_clocks() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let uid = "4".repeat(32);
        let replacement = "5".repeat(32);
        let old_hash = "a".repeat(64);
        let new_hash = "b".repeat(64);
        let snapshot = json!({"aliases": [old_hash.clone()]}).to_string();

        let mut forget = op(EntityKind::Book, &uid, &uid, json!({}));
        forget.deleted = true;
        forget.fields = Map::new();
        forget.hlc.wall = 100;
        forget.prior = Some(
            json!({
                "snapshot": snapshot,
                "replacement_book_uid": replacement,
                "discarded": null,
            })
            .as_object()
            .cloned()
            .unwrap(),
        );
        let affected = apply_op(&pool, &forget, "a.json").await.unwrap();
        assert_eq!(affected.len(), 1);
        let (restored, discarded): (Option<String>, i64) = sqlx::query_as(
            "SELECT restored_at, discarded FROM sync_book_trash WHERE book_uid = ?1",
        )
        .bind(&uid)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(restored.is_none());
        assert_eq!(discarded, 0);
        let owner: String =
            sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
                .bind(&old_hash)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            owner, replacement,
            "the snapshot alias moves to the fresh id"
        );

        // A stale Forget loses to the one already recorded.
        let mut stale_forget = forget.clone();
        stale_forget.op_id = format!("{:032x}", rand_id());
        stale_forget.hlc.wall = 99;
        assert!(apply_op(&pool, &stale_forget, "b.json")
            .await
            .unwrap()
            .is_empty());

        // Restore clears the tombstone and brings the snapshot aliases back.
        let mut restore = op(EntityKind::Book, &uid, &uid, json!({}));
        restore.fields = json!({
            "snapshot": json!({"aliases": [new_hash.clone()]}).to_string(),
            "replacement_book_uid": replacement,
            "discarded": false,
        })
        .as_object()
        .cloned()
        .unwrap();
        restore.hlc.wall = 300;
        apply_op(&pool, &restore, "c.json").await.unwrap();
        let (restored, deleted): (Option<String>, i64) = sqlx::query_as(
            "SELECT t.restored_at, e.deleted FROM sync_book_trash t
             JOIN sync_state_entities e ON e.kind = 'book' AND e.entity_uid = t.book_uid
             WHERE t.book_uid = ?1",
        )
        .bind(&uid)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(restored.is_some());
        assert_eq!(deleted, 0);
        let fresh_aliases: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_aliases WHERE book_uid = ?1")
                .bind(replacement)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(fresh_aliases, 0, "the replacement's aliases are dropped");
        let owner: String =
            sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
                .bind(&new_hash)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(owner, uid);

        // An older restore loses to the restored clock.
        let mut stale_restore = restore.clone();
        stale_restore.op_id = format!("{:032x}", rand_id());
        stale_restore.hlc.wall = 200;
        assert!(apply_op(&pool, &stale_restore, "d.json")
            .await
            .unwrap()
            .is_empty());

        // Discard keeps the identity forgotten and closes the trash entry.
        let mut discard = op(EntityKind::Book, &uid, &uid, json!({}));
        discard.fields = json!({"discarded": true, "snapshot": null})
            .as_object()
            .cloned()
            .unwrap();
        discard.hlc.wall = 400;
        apply_op(&pool, &discard, "e.json").await.unwrap();
        let (restored, discarded, deleted): (Option<String>, i64, i64) = sqlx::query_as(
            "SELECT t.restored_at, t.discarded, e.deleted FROM sync_book_trash t
             JOIN sync_state_entities e ON e.kind = 'book' AND e.entity_uid = t.book_uid
             WHERE t.book_uid = ?1",
        )
        .bind(&uid)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(restored.is_some());
        assert_eq!(discarded, 1);
        assert_eq!(deleted, 1);
    }

    #[tokio::test]
    async fn a_restore_without_a_snapshot_is_reported_instead_of_claimed() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let uid = "6".repeat(32);
        let mut restore = op(EntityKind::Book, &uid, &uid, json!({}));
        restore.fields = json!({"discarded": false, "snapshot": null})
            .as_object()
            .cloned()
            .unwrap();
        restore.hlc.wall = 100;
        apply_op(&pool, &restore, "a.json").await.unwrap();
        let key: String = sqlx::query_scalar(
            "SELECT issue_key FROM sync_issues WHERE kind = 'book_snapshot_missing'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(key.starts_with("restore-snapshot-missing:"), "{key}");
        let discarded: i64 =
            sqlx::query_scalar("SELECT discarded FROM sync_book_trash WHERE book_uid = ?1")
                .bind(&uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(discarded, 1);
    }

    #[tokio::test]
    async fn a_delete_keeps_the_prior_payload_and_ignores_stale_or_repeated_deletes() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let uid = "7".repeat(32);
        let mut delete = op(EntityKind::Annotation, &uid, &book, json!({}));
        delete.deleted = true;
        delete.fields = Map::new();
        delete.hlc.wall = 100;
        delete.prior = Some(
            json!({"kind": "bookmark", "cfi": "x", "note": "keep"})
                .as_object()
                .cloned()
                .unwrap(),
        );
        apply_op(&pool, &delete, "a.json").await.unwrap();
        let prior_json: String =
            sqlx::query_scalar("SELECT prior_json FROM sync_trash WHERE entity_uid = ?1")
                .bind(&uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        let prior: Value = serde_json::from_str(&prior_json).unwrap();
        assert_eq!(prior["note"], json!("keep"));

        // A repeat of the delete is a no-op, not a second trash entry.
        let mut again = delete.clone();
        again.op_id = format!("{:032x}", rand_id());
        again.hlc.wall = 200;
        apply_op(&pool, &again, "b.json").await.unwrap();
        let entries: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_trash WHERE entity_uid = ?1")
                .bind(&uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(entries, 1);

        // An entity-mode delete older than the last locator is ignored.
        let progress = "8".repeat(32);
        let mut newer = op(
            EntityKind::Progress,
            &progress,
            &book,
            json!({"progress_percent": 50.0}),
        );
        newer.hlc.wall = 200;
        apply_op(&pool, &newer, "c.json").await.unwrap();
        let mut stale = op(EntityKind::Progress, &progress, &book, json!({}));
        stale.deleted = true;
        stale.fields = Map::new();
        stale.hlc.wall = 150;
        apply_op(&pool, &stale, "d.json").await.unwrap();
        let (state, deleted) = load_state(&pool, EntityKind::Progress, &progress)
            .await
            .unwrap();
        assert!(!deleted);
        assert_eq!(state.get("progress_percent"), Some(&json!(50.0)));

        // A delete older than an explicit restore is ignored.
        let restored = "9".repeat(32);
        apply_op(
            &pool,
            &op(
                EntityKind::Annotation,
                &restored,
                &book,
                json!({"note": "back"}),
            ),
            "e.json",
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE sync_state_entities SET restored_wall = 500, restored_count = 0,
             restored_dev = 'other' WHERE kind = 'annotation' AND entity_uid = ?1",
        )
        .bind(&restored)
        .execute(&pool)
        .await
        .unwrap();
        let mut old_delete = op(EntityKind::Annotation, &restored, &book, json!({}));
        old_delete.deleted = true;
        old_delete.fields = Map::new();
        old_delete.hlc.wall = 400;
        apply_op(&pool, &old_delete, "f.json").await.unwrap();
        let (_, deleted) = load_state(&pool, EntityKind::Annotation, &restored)
            .await
            .unwrap();
        assert!(!deleted);
    }

    #[tokio::test]
    async fn older_entity_ops_and_equal_values_do_not_create_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let progress = "a1".repeat(16);
        let mut newer = op(
            EntityKind::Progress,
            &progress,
            &book,
            json!({"progress_percent": 60.0}),
        );
        newer.hlc.wall = 200;
        apply_op(&pool, &newer, "a.json").await.unwrap();
        let mut older = op(
            EntityKind::Progress,
            &progress,
            &book,
            json!({"progress_percent": 10.0}),
        );
        older.hlc.wall = 100;
        apply_op(&pool, &older, "b.json").await.unwrap();
        let (state, _) = load_state(&pool, EntityKind::Progress, &progress)
            .await
            .unwrap();
        assert_eq!(state.get("progress_percent"), Some(&json!(60.0)));
        let entity_conflict: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_conflicts WHERE entity_uid = ?1 AND field = '__entity__'",
        )
        .bind(&progress)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(entity_conflict, 1);

        // The same value from an older clock is not a conflict at all.
        let annotation = "b1".repeat(16);
        let mut first = op(
            EntityKind::Annotation,
            &annotation,
            &book,
            json!({"note": "same"}),
        );
        first.hlc.wall = 200;
        apply_op(&pool, &first, "c.json").await.unwrap();
        let mut same = op(
            EntityKind::Annotation,
            &annotation,
            &book,
            json!({"note": "same"}),
        );
        same.hlc.wall = 100;
        apply_op(&pool, &same, "d.json").await.unwrap();
        let conflicts: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts WHERE entity_uid = ?1")
                .bind(&annotation)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(conflicts, 0);
    }

    #[tokio::test]
    async fn a_tombstone_conflict_for_a_live_entity_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let uid = "c1".repeat(16);
        apply_op(
            &pool,
            &op(EntityKind::Annotation, &uid, &book, json!({"note": "live"})),
            "a.json",
        )
        .await
        .unwrap();
        let mut state = State::new();
        state.insert("note".into(), json!("late"));
        record_tombstone_conflict(&pool, EntityKind::Annotation, &uid, &state)
            .await
            .unwrap();
        let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(conflicts, 0);
    }

    #[tokio::test]
    async fn a_local_edit_after_a_tombstone_records_its_device_and_time() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let uid = "c4".repeat(16);
        apply_op(
            &pool,
            &op(EntityKind::Annotation, &uid, &book, json!({"note": "live"})),
            "a.json",
        )
        .await
        .unwrap();
        let mut delete = op(EntityKind::Annotation, &uid, &book, json!({}));
        delete.deleted = true;
        delete.fields = Map::new();
        delete.hlc.wall = 200;
        apply_op(&pool, &delete, "b.json").await.unwrap();

        let mut state = State::new();
        state.insert("note".into(), json!("late edit"));
        record_tombstone_conflict(&pool, EntityKind::Annotation, &uid, &state)
            .await
            .unwrap();

        let row: (String, i64, i64, String) = sqlx::query_as(
            "SELECT loser_dev, loser_wall, loser_count, field FROM sync_conflicts
             WHERE entity_uid = ?1",
        )
        .bind(&uid)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.3, "__deleted__");
        assert_eq!(row.0, device_id(&pool).await.unwrap());
        assert!(row.1 > 0, "the losing edit has a real wall time");
        assert_eq!(row.2, 0);
    }

    #[tokio::test]
    async fn project_creates_updates_and_deletes_collections_by_uid_or_name() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let covers = tmp.path().join("covers");
        let dir = tempfile::tempdir().unwrap();

        let uid = "c2".repeat(16);
        put_state(
            &pool,
            EntityKind::Collection,
            &uid,
            &[
                ("name", json!("Shelf")),
                ("created_at", json!("2026-01-01T00:00:00.000Z")),
            ],
        )
        .await;
        let affected = |uid: &str| {
            vec![Affected {
                kind: EntityKind::Collection,
                entity_uid: uid.into(),
                book_uid: None,
            }]
        };
        assert!(project(&pool, dir.path(), &covers, &affected(&uid))
            .await
            .unwrap()
            .is_empty());
        let (id, name): (i64, String) =
            sqlx::query_as("SELECT id, name FROM collections WHERE sync_uid = ?1")
                .bind(&uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(name, "Shelf");

        put_state(
            &pool,
            EntityKind::Collection,
            &uid,
            &[("name", json!("Renamed"))],
        )
        .await;
        project(&pool, dir.path(), &covers, &affected(&uid))
            .await
            .unwrap();
        let name: String = sqlx::query_scalar("SELECT name FROM collections WHERE id = ?1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(name, "Renamed");

        // A local shelf with no portable uid adopts the first uid it sees.
        let unnamed: i64 =
            sqlx::query_scalar("INSERT INTO collections (name) VALUES ('Local only') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();
        let taken = "c3".repeat(16);
        put_state(
            &pool,
            EntityKind::Collection,
            &taken,
            &[("name", json!("Local only"))],
        )
        .await;
        project(&pool, dir.path(), &covers, &affected(&taken))
            .await
            .unwrap();
        let sync_uid: String = sqlx::query_scalar("SELECT sync_uid FROM collections WHERE id = ?1")
            .bind(unnamed)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(sync_uid, taken);

        // Two portable ids for one name converge on the smaller one.
        let local = "f".repeat(32);
        let remote = "d4".repeat(16);
        sqlx::query("INSERT INTO collections (name, sync_uid) VALUES ('Shared', ?1)")
            .bind(&local)
            .execute(&pool)
            .await
            .unwrap();
        put_state(
            &pool,
            EntityKind::Collection,
            &remote,
            &[("name", json!("Shared"))],
        )
        .await;
        project(&pool, dir.path(), &covers, &affected(&remote))
            .await
            .unwrap();
        let winner: String =
            sqlx::query_scalar("SELECT sync_uid FROM collections WHERE name = 'Shared'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(winner, remote, "the lexicographically smaller uid survives");

        // A state with no name is ignored, and a tombstone removes the shelf.
        let nameless = "e5".repeat(16);
        put_state(&pool, EntityKind::Collection, &nameless, &[]).await;
        project(&pool, dir.path(), &covers, &affected(&nameless))
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collections WHERE sync_uid = ?1")
            .bind(&nameless)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);

        sqlx::query("UPDATE sync_state_entities SET deleted = 1 WHERE kind = 'collection' AND entity_uid = ?1")
            .bind(&taken)
            .execute(&pool)
            .await
            .unwrap();
        project(&pool, dir.path(), &covers, &affected(&taken))
            .await
            .unwrap();
        let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collections WHERE id = ?1")
            .bind(unnamed)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(gone, 0);
    }

    #[tokio::test]
    async fn project_adds_and_removes_memberships_and_skips_missing_parents() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
        let collection_uid = "d6".repeat(16);
        let collection_id: i64 = sqlx::query_scalar(
            "INSERT INTO collections (name, sync_uid) VALUES ('Shelf', ?1) RETURNING id",
        )
        .bind(&collection_uid)
        .fetch_one(&pool)
        .await
        .unwrap();
        let entity_uid = format!("{collection_uid}:{book_uid}");
        put_state(
            &pool,
            EntityKind::Membership,
            &entity_uid,
            &[("present", json!(true))],
        )
        .await;
        let item = |uid: &str, book: Option<&str>| {
            vec![Affected {
                kind: EntityKind::Membership,
                entity_uid: uid.into(),
                book_uid: book.map(str::to_string),
            }]
        };
        let covers = tmp.path().join("covers");
        project(
            &pool,
            tmp.path(),
            &covers,
            &item(&entity_uid, Some(&book_uid)),
        )
        .await
        .unwrap();
        let members: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM book_collections WHERE book_uid = ?1 AND collection_id = ?2",
        )
        .bind(&book_uid)
        .bind(collection_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(members, 1);

        put_state(
            &pool,
            EntityKind::Membership,
            &entity_uid,
            &[("present", json!(false))],
        )
        .await;
        project(
            &pool,
            tmp.path(),
            &covers,
            &item(&entity_uid, Some(&book_uid)),
        )
        .await
        .unwrap();
        let members: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM book_collections WHERE book_uid = ?1 AND collection_id = ?2",
        )
        .bind(&book_uid)
        .bind(collection_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(members, 0);

        // Unknown book, unknown collection, and a uid with no colon are inert.
        let unknown_book = "d7".repeat(16);
        let unknown_entity = format!("{collection_uid}:{unknown_book}");
        put_state(
            &pool,
            EntityKind::Membership,
            &unknown_entity,
            &[("present", json!(true))],
        )
        .await;
        project(
            &pool,
            tmp.path(),
            &covers,
            &item(&unknown_entity, Some(&unknown_book)),
        )
        .await
        .unwrap();
        let unknown_collection = format!("{}:{book_uid}", "d8".repeat(16));
        put_state(
            &pool,
            EntityKind::Membership,
            &unknown_collection,
            &[("present", json!(true))],
        )
        .await;
        project(
            &pool,
            tmp.path(),
            &covers,
            &item(&unknown_collection, Some(&book_uid)),
        )
        .await
        .unwrap();
        project(
            &pool,
            tmp.path(),
            &covers,
            &item("no-colon", Some(&book_uid)),
        )
        .await
        .unwrap();
        let members: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_collections")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(members, 0);
    }

    #[tokio::test]
    async fn project_removes_deleted_annotations_progress_and_updates_opened() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
        let annotation_uid = "d9".repeat(16);
        sqlx::query(
            "INSERT INTO annotations (book_uid, sync_uid, kind, cfi) VALUES (?1, ?2, 'bookmark', 'x')",
        )
        .bind(&book_uid)
        .bind(&annotation_uid)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO reading_progress (book_uid, progress_percent) VALUES (?1, 10.0)")
            .bind(&book_uid)
            .execute(&pool)
            .await
            .unwrap();
        put_state(&pool, EntityKind::Annotation, &annotation_uid, &[]).await;
        put_state(&pool, EntityKind::Progress, &book_uid, &[]).await;
        sqlx::query(
            "UPDATE sync_state_entities SET deleted = 1 WHERE
                (kind = 'annotation' AND entity_uid = ?1)
             OR (kind = 'progress' AND entity_uid = ?2)",
        )
        .bind(&annotation_uid)
        .bind(&book_uid)
        .execute(&pool)
        .await
        .unwrap();
        let covers = tmp.path().join("covers");
        let affected = vec![
            Affected {
                kind: EntityKind::Annotation,
                entity_uid: annotation_uid.clone(),
                book_uid: Some(book_uid.clone()),
            },
            Affected {
                kind: EntityKind::Progress,
                entity_uid: book_uid.clone(),
                book_uid: Some(book_uid.clone()),
            },
        ];
        let books = project(&pool, tmp.path(), &covers, &affected)
            .await
            .unwrap();
        assert_eq!(books, vec![1]);
        let annotations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM annotations WHERE sync_uid = ?1")
                .bind(&annotation_uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(annotations, 0);
        let progress: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM reading_progress WHERE book_uid = ?1")
                .bind(&book_uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(progress, 0);

        // The last-opened stamp projects straight into the durable record.
        put_state(
            &pool,
            EntityKind::Opened,
            &book_uid,
            &[("last_opened_at", json!("2026-02-03T04:05:06.000Z"))],
        )
        .await;
        project(
            &pool,
            tmp.path(),
            &covers,
            &[Affected {
                kind: EntityKind::Opened,
                entity_uid: book_uid.clone(),
                book_uid: Some(book_uid.clone()),
            }],
        )
        .await
        .unwrap();
        let opened: Option<String> =
            sqlx::query_scalar("SELECT last_opened_at FROM book_records WHERE uid = ?1")
                .bind(&book_uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(opened.as_deref(), Some("2026-02-03T04:05:06.000Z"));
    }

    #[tokio::test]
    async fn project_skips_identity_ops_and_books_without_a_durable_record() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let covers = tmp.path().join("covers");
        let affected = vec![
            Affected {
                kind: EntityKind::BookIdentity,
                entity_uid: "e1".repeat(16),
                book_uid: None,
            },
            Affected {
                kind: EntityKind::Annotation,
                entity_uid: "e2".repeat(16),
                book_uid: Some("e3".repeat(16)),
            },
            Affected {
                kind: EntityKind::Collection,
                entity_uid: "e4".repeat(16),
                book_uid: None,
            },
        ];
        assert!(project(&pool, tmp.path(), &covers, &affected)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_membership_op_without_a_colon_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let bad = op(
            EntityKind::Membership,
            "no-colon",
            &book,
            json!({"present": true}),
        );
        let err = apply_op(&pool, &bad, "a.json").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn project_book_returns_nothing_for_a_forgotten_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let uid = "e5".repeat(16);
        forget_book(&pool, &uid, None).await;
        let covers = tmp.path().join("covers");
        assert!(project_book(&pool, &uid, tmp.path(), &covers)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_second_forget_after_a_restore_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let uid = "f1".repeat(16);
        sqlx::query(
            "INSERT INTO sync_book_trash
                (book_uid, snapshot_json, deleted_wall, deleted_count, deleted_dev,
                 deleted_at, expires_at, restored_at, restored_wall, restored_count,
                 restored_dev)
             VALUES (?1, NULL, 50, 0, 'other', '2026-01-01T00:00:00.000Z',
                     '2999-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 500, 0,
                     'other')",
        )
        .bind(&uid)
        .execute(&pool)
        .await
        .unwrap();

        let mut forget = op(EntityKind::Book, &uid, &uid, json!({}));
        forget.deleted = true;
        forget.fields = Map::new();
        forget.hlc.wall = 100;
        let affected = apply_op(&pool, &forget, "a.json").await.unwrap();
        assert!(
            affected.is_empty(),
            "a delayed Forget cannot undo a completed restore"
        );
        let restored: Option<String> =
            sqlx::query_scalar("SELECT restored_at FROM sync_book_trash WHERE book_uid = ?1")
                .bind(&uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(restored.is_some());
    }

    #[tokio::test]
    async fn a_restore_older_than_the_tombstone_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let uid = "f2".repeat(16);
        sqlx::query(
            "INSERT INTO sync_book_trash
                (book_uid, snapshot_json, deleted_wall, deleted_count, deleted_dev,
                 deleted_at, expires_at)
             VALUES (?1, NULL, 500, 0, 'other', '2026-01-01T00:00:00.000Z',
                     '2999-01-01T00:00:00.000Z')",
        )
        .bind(&uid)
        .execute(&pool)
        .await
        .unwrap();

        let mut restore = op(EntityKind::Book, &uid, &uid, json!({}));
        restore.fields = json!({"discarded": false, "snapshot": null})
            .as_object()
            .cloned()
            .unwrap();
        restore.hlc.wall = 400;
        let affected = apply_op(&pool, &restore, "a.json").await.unwrap();
        assert!(affected.is_empty());
        let restored: Option<String> =
            sqlx::query_scalar("SELECT restored_at FROM sync_book_trash WHERE book_uid = ?1")
                .bind(&uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(restored.is_none(), "the newer tombstone still stands");
    }

    #[tokio::test]
    async fn a_restore_older_than_the_tombstone_is_kept_as_a_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let uid = "f3".repeat(16);
        let mut delete = op(EntityKind::Annotation, &uid, &book, json!({}));
        delete.deleted = true;
        delete.fields = Map::new();
        delete.hlc.wall = 200;
        apply_op(&pool, &delete, "a.json").await.unwrap();

        let mut restore = op(
            EntityKind::Annotation,
            &uid,
            &book,
            json!({"note": "late restore"}),
        );
        restore.restore = true;
        restore.hlc.wall = 100;
        apply_op(&pool, &restore, "b.json").await.unwrap();

        let (_, deleted) = load_state(&pool, EntityKind::Annotation, &uid)
            .await
            .unwrap();
        assert!(deleted, "an older restore cannot resurrect the delete");
        let conflicts: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_conflicts WHERE entity_uid = ?1 AND field = '__restore__'",
        )
        .bind(&uid)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(conflicts, 1);
    }

    #[tokio::test]
    async fn a_newer_progress_delete_tombstones_the_locator() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;
        let uid = "f4".repeat(16);
        let mut progress = op(
            EntityKind::Progress,
            &uid,
            &book,
            json!({"progress_percent": 30.0}),
        );
        progress.hlc.wall = 100;
        apply_op(&pool, &progress, "a.json").await.unwrap();

        let mut delete = op(EntityKind::Progress, &uid, &book, json!({}));
        delete.deleted = true;
        delete.fields = Map::new();
        delete.hlc.wall = 200;
        apply_op(&pool, &delete, "b.json").await.unwrap();

        let (_, deleted) = load_state(&pool, EntityKind::Progress, &uid).await.unwrap();
        assert!(deleted);
    }

    #[tokio::test]
    async fn identical_older_values_and_repeated_conflicts_stay_quiet() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let book = create_book(&pool).await;

        // An identical older progress op is not a conflict. Entity mode keeps
        // the whole locator, so the comparison is against the full field set.
        let progress = "f5".repeat(16);
        let locator = |page: u64| {
            json!({
                "chapter_href": "c.xhtml",
                "cfi": "epubcfi(/6/4)",
                "character_offset": 0,
                "page_number": page,
                "scroll_offset": 0.0,
                "progress_percent": 60.0,
                "locator": "x",
                "progression": 0.6,
                "locations": "{}",
                "engine": "readium",
                "schema_version": 2
            })
        };
        let mut newer = op(EntityKind::Progress, &progress, &book, locator(4));
        newer.hlc.wall = 200;
        apply_op(&pool, &newer, "a.json").await.unwrap();
        let mut identical = op(EntityKind::Progress, &progress, &book, locator(4));
        identical.hlc.wall = 100;
        apply_op(&pool, &identical, "b.json").await.unwrap();
        let conflicts: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts WHERE entity_uid = ?1")
                .bind(&progress)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(conflicts, 0);

        // Two losing edits share one open issue and keep both conflict rows.
        let annotation = "f6".repeat(16);
        let mut newest = op(
            EntityKind::Annotation,
            &annotation,
            &book,
            json!({"note": "newest"}),
        );
        newest.hlc.wall = 300;
        apply_op(&pool, &newest, "c.json").await.unwrap();
        for (wall, note) in [(200, "older one"), (100, "older two")] {
            let mut older = op(
                EntityKind::Annotation,
                &annotation,
                &book,
                json!({"note": note}),
            );
            older.hlc.wall = wall;
            apply_op(&pool, &older, "d.json").await.unwrap();
        }
        let conflicts: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts WHERE entity_uid = ?1")
                .bind(&annotation)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(conflicts, 2);
        let issues: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sync_issues WHERE issue_key LIKE ?1 AND resolved_at IS NULL",
        )
        .bind(format!("conflict:annotation:{annotation}:note"))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(issues, 1, "one issue per field, refreshed in place");
    }

    #[tokio::test]
    async fn applying_an_op_with_a_merged_book_uid_uses_the_winner() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let loser = "f7".repeat(16);
        let winner = "f8".repeat(16);
        sqlx::query("INSERT INTO sync_book_merges (loser, winner) VALUES (?1, ?2)")
            .bind(&loser)
            .bind(&winner)
            .execute(&pool)
            .await
            .unwrap();
        let affected = apply_op(
            &pool,
            &op(
                EntityKind::Annotation,
                &"f9".repeat(16),
                &loser,
                json!({"note": "via alias"}),
            ),
            "a.json",
        )
        .await
        .unwrap();
        assert_eq!(affected[0].book_uid.as_deref(), Some(winner.as_str()));
    }

    #[tokio::test]
    async fn project_skips_a_missing_book_uid_and_a_book_without_a_trash_row() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let covers = tmp.path().join("covers");
        let affected = vec![
            Affected {
                kind: EntityKind::Annotation,
                entity_uid: "fa".repeat(16),
                book_uid: None,
            },
            Affected {
                kind: EntityKind::Book,
                entity_uid: "fb".repeat(16),
                book_uid: None,
            },
        ];
        assert!(project(&pool, tmp.path(), &covers, &affected)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_corrupt_shared_snapshot_becomes_a_lifecycle_issue() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let uid = "fc".repeat(16);
        sqlx::query(
            "INSERT INTO sync_book_trash
                (book_uid, replacement_book_uid, snapshot_json, deleted_wall,
                 deleted_count, deleted_dev, deleted_at, expires_at, restored_at,
                 discarded, restored_wall, restored_count, restored_dev)
             VALUES (?1, NULL, '{not json', 10, 0, 'other',
                     '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z',
                     '2026-01-02T00:00:00.000Z', 0, 20, 0, 'other')",
        )
        .bind(&uid)
        .execute(&pool)
        .await
        .unwrap();
        let covers = tmp.path().join("covers");
        assert!(project(
            &pool,
            tmp.path(),
            &covers,
            &[Affected {
                kind: EntityKind::Book,
                entity_uid: uid.clone(),
                book_uid: Some(uid.clone()),
            }],
        )
        .await
        .unwrap()
        .is_empty());
        let issue: String = sqlx::query_scalar(
            "SELECT detail FROM sync_issues WHERE kind = 'book_lifecycle_failed'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(issue.contains(&uid), "{issue}");
    }

    #[tokio::test]
    async fn metadata_projection_without_a_cover_blob_still_applies() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
        let covers = tmp.path().join("covers");

        put_state(
            &pool,
            EntityKind::Metadata,
            &book_uid,
            &[
                ("title", json!("Missing cover")),
                ("cover_path", json!("0123456789abcdef.png")),
            ],
        )
        .await;
        project(
            &pool,
            tmp.path(),
            &covers,
            &[Affected {
                kind: EntityKind::Metadata,
                entity_uid: book_uid.clone(),
                book_uid: Some(book_uid.clone()),
            }],
        )
        .await
        .unwrap();
        let (title, cover): (String, Option<String>) =
            sqlx::query_as("SELECT title, cover_path FROM book_records WHERE uid = ?1")
                .bind(&book_uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title, "Missing cover");
        assert!(cover.is_none(), "the missing blob is not invented");

        put_state(
            &pool,
            EntityKind::Metadata,
            &book_uid,
            &[
                ("title", json!("No cover field")),
                ("cover_path", Value::Null),
            ],
        )
        .await;
        project(
            &pool,
            tmp.path(),
            &covers,
            &[Affected {
                kind: EntityKind::Metadata,
                entity_uid: book_uid.clone(),
                book_uid: Some(book_uid.clone()),
            }],
        )
        .await
        .unwrap();
        let (title, cover): (String, Option<String>) =
            sqlx::query_as("SELECT title, cover_path FROM book_records WHERE uid = ?1")
                .bind(&book_uid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title, "No cover field");
        assert!(cover.is_none(), "a null cover clears the stored path");
    }

    #[tokio::test]
    async fn collection_projection_skips_memberships_for_unknown_or_deleted_books() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let covers = tmp.path().join("covers");
        let collection_uid = "fd".repeat(16);
        put_state(
            &pool,
            EntityKind::Collection,
            &collection_uid,
            &[("name", json!("Shelf"))],
        )
        .await;
        let unknown_book = "fe".repeat(16);
        let unknown_entity = format!("{collection_uid}:{unknown_book}");
        put_state(
            &pool,
            EntityKind::Membership,
            &unknown_entity,
            &[("present", json!(true))],
        )
        .await;
        let deleted_book = "ff".repeat(16);
        let deleted_entity = format!("{collection_uid}:{deleted_book}");
        put_state(
            &pool,
            EntityKind::Membership,
            &deleted_entity,
            &[("present", json!(true))],
        )
        .await;
        sqlx::query("UPDATE sync_state_entities SET deleted = 1 WHERE entity_uid = ?1")
            .bind(&deleted_entity)
            .execute(&pool)
            .await
            .unwrap();

        project(
            &pool,
            tmp.path(),
            &covers,
            &[Affected {
                kind: EntityKind::Collection,
                entity_uid: collection_uid,
                book_uid: None,
            }],
        )
        .await
        .unwrap();
        let members: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_collections")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(members, 0, "neither membership can be projected");
    }

    #[tokio::test]
    async fn apply_identity_resolves_a_forgotten_alias_owner() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();

        // The old alias owner has a replacement: the alias follows it.
        let hash = "d1".repeat(32);
        let dead = "d2".repeat(16);
        let fresh = "d3".repeat(16);
        forget_book(&pool, &dead, Some(&fresh)).await;
        sqlx::query("INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)")
            .bind(&hash)
            .bind(&dead)
            .execute(&pool)
            .await
            .unwrap();
        let incoming = "d4".repeat(16);
        let identity = op(
            EntityKind::BookIdentity,
            &incoming,
            &incoming,
            json!({"content_hash": hash}),
        );
        let affected = apply_op(&pool, &identity, "a.json").await.unwrap();
        assert_eq!(affected[0].entity_uid, fresh);
        let owner: String =
            sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
                .bind(&hash)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(owner, fresh);

        // The old alias owner was forgotten with no replacement: the incoming
        // identity owns the hash.
        let orphan_hash = "d5".repeat(32);
        let orphan = "d6".repeat(16);
        forget_book(&pool, &orphan, None).await;
        sqlx::query("INSERT INTO sync_book_aliases (content_hash, book_uid) VALUES (?1, ?2)")
            .bind(&orphan_hash)
            .bind(&orphan)
            .execute(&pool)
            .await
            .unwrap();
        let orphan_incoming = "a0".repeat(16);
        let identity = op(
            EntityKind::BookIdentity,
            &orphan_incoming,
            &orphan_incoming,
            json!({"content_hash": orphan_hash}),
        );
        apply_op(&pool, &identity, "b.json").await.unwrap();
        let owner: String =
            sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
                .bind(&orphan_hash)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(owner, orphan_incoming);
    }

    #[tokio::test]
    async fn applying_a_collection_op_uses_the_merged_entity_uid() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
            .await
            .unwrap();
        let loser = "e1".repeat(16);
        let winner = "e2".repeat(16);
        sqlx::query(
            "INSERT INTO sync_entity_merges (kind, loser, winner) VALUES ('collection', ?1, ?2)",
        )
        .bind(&loser)
        .bind(&winner)
        .execute(&pool)
        .await
        .unwrap();
        let affected = apply_op(
            &pool,
            &op(EntityKind::Collection, &loser, "", json!({"name": "Shelf"})),
            "a.json",
        )
        .await
        .unwrap();
        assert_eq!(affected[0].entity_uid, winner);
        let (state, _) = load_state(&pool, EntityKind::Collection, &winner)
            .await
            .unwrap();
        assert_eq!(state.get("name"), Some(&json!("Shelf")));
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
