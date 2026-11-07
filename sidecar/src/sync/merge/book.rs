//! Book-level operations: portable identity and the whole-book
//! Forget/restore/discard lifecycle.

use serde_json::Value;
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppError;
use crate::sync::clock::now_rfc3339;
use crate::sync::identity::merge_book_identity;
use crate::sync::model::{EntityKind, Hlc, Op, TRASH_DAYS};

use super::Affected;

pub(super) async fn apply_identity(pool: &SqlitePool, op: &Op) -> Result<Vec<Affected>, AppError> {
    let content_hash = op
        .fields
        .get("content_hash")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::InvalidInput("identity op is missing content_hash".into()))?;
    let incoming = crate::sync::identity::canonical_book_uid(pool, &op.entity_uid).await?;
    let incoming = match crate::sync::identity::forgotten_replacement(pool, &incoming).await? {
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
        Some(existing) => {
            match crate::sync::identity::forgotten_replacement(pool, &existing).await? {
                Some(Some(replacement)) => Some(replacement),
                Some(None) => None,
                None => Some(crate::sync::identity::canonical_book_uid(pool, &existing).await?),
            }
        }
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
pub(super) async fn apply_book(pool: &SqlitePool, op: &Op) -> Result<Vec<Affected>, AppError> {
    let book_uid = crate::sync::identity::canonical_book_uid(pool, &op.entity_uid).await?;
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
        crate::sync::identity::record_issue(
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

pub(super) fn snapshot_aliases(snapshot: Option<&str>) -> Vec<String> {
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
                .filter(|hash| crate::sync::model::is_hex_hash(hash))
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_aliases_keeps_only_full_hex_hashes() {
        let hash = "a".repeat(64);
        let snapshot =
            serde_json::json!({"aliases": [hash.clone(), "short", 7, "A".repeat(64)]}).to_string();
        assert_eq!(snapshot_aliases(Some(&snapshot)), vec![hash]);
        assert!(snapshot_aliases(None).is_empty());
        assert!(snapshot_aliases(Some("{not json")).is_empty());
        assert!(snapshot_aliases(Some(r#"{"aliases":"not-a-list"}"#)).is_empty());
    }
}
