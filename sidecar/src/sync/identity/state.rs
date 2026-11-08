//! Sync-state rekeying: moving durable entity state between uids.

use crate::error::AppError;
use crate::sync::model::{EntityKind, Hlc, MergeMode};

/// Re-key one entity kind's durable state from `loser` to `winner`, keeping
/// whichever side's clock is newer (entity mode) or field by field
/// (field mode).
pub(super) async fn merge_self_keyed(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: EntityKind,
    loser: &str,
    winner: &str,
) -> Result<(), AppError> {
    if kind.merge_mode() == MergeMode::Entity {
        let loser_clock = entity_clock(tx, kind, loser).await?;
        let winner_clock = entity_clock(tx, kind, winner).await?;
        match (loser_clock, winner_clock) {
            (Some(loser_hlc), Some(winner_hlc)) => {
                if loser_hlc > winner_hlc {
                    sqlx::query(
                        "DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2",
                    )
                    .bind(kind.as_str())
                    .bind(winner)
                    .execute(&mut **tx)
                    .await?;
                    sqlx::query(
                        "DELETE FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2",
                    )
                    .bind(kind.as_str())
                    .bind(winner)
                    .execute(&mut **tx)
                    .await?;
                    rekey_entity_uid(tx, kind, loser, winner, Some(winner)).await?;
                } else {
                    sqlx::query(
                        "DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2",
                    )
                    .bind(kind.as_str())
                    .bind(loser)
                    .execute(&mut **tx)
                    .await?;
                    sqlx::query(
                        "DELETE FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2",
                    )
                    .bind(kind.as_str())
                    .bind(loser)
                    .execute(&mut **tx)
                    .await?;
                }
            }
            (Some(_), None) => {
                rekey_entity_uid(tx, kind, loser, winner, Some(winner)).await?;
            }
            _ => {}
        }
    } else {
        // Field-level: each field keeps whichever clock is newer. The winner
        // entity may not exist yet (the only state was under the loser), so
        // materialize the entity row before moving fields under it.
        sqlx::query(
            r#"
            INSERT INTO sync_state_entities
                (kind, entity_uid, book_uid, hlc_wall, hlc_counter, hlc_device,
                 deleted, deleted_wall, deleted_count, deleted_dev,
                 restored_wall, restored_count, restored_dev)
            SELECT kind, ?2, ?2, hlc_wall, hlc_counter, hlc_device,
                   deleted, deleted_wall, deleted_count, deleted_dev,
                   restored_wall, restored_count, restored_dev
            FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?3
            ON CONFLICT(kind, entity_uid) DO NOTHING
            "#,
        )
        .bind(kind.as_str())
        .bind(winner)
        .bind(loser)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO sync_state_entities (kind, entity_uid, book_uid)
            SELECT ?1, ?2, ?2
            WHERE EXISTS (
                SELECT 1 FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?3
            )
            ON CONFLICT(kind, entity_uid) DO NOTHING
            "#,
        )
        .bind(kind.as_str())
        .bind(winner)
        .bind(loser)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
            SELECT kind, ?2, field, value_json, hlc_wall, hlc_counter, hlc_device
            FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?3
            ON CONFLICT(kind, entity_uid, field) DO UPDATE SET
                value_json = excluded.value_json,
                hlc_wall = excluded.hlc_wall,
                hlc_counter = excluded.hlc_counter,
                hlc_device = excluded.hlc_device
            WHERE (excluded.hlc_wall, excluded.hlc_counter, excluded.hlc_device)
                > (sync_state_fields.hlc_wall, sync_state_fields.hlc_counter,
                   sync_state_fields.hlc_device)
            "#,
        )
        .bind(kind.as_str())
        .bind(winner)
        .bind(loser)
        .execute(&mut **tx)
        .await?;
        sqlx::query("DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2")
            .bind(kind.as_str())
            .bind(loser)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2")
            .bind(kind.as_str())
            .bind(loser)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn entity_clock(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: EntityKind,
    uid: &str,
) -> Result<Option<Hlc>, AppError> {
    let row: Option<(i64, i64, String)> = sqlx::query_as(
        "SELECT hlc_wall, hlc_counter, hlc_device FROM sync_state_entities
         WHERE kind = ?1 AND entity_uid = ?2",
    )
    .bind(kind.as_str())
    .bind(uid)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|(wall, counter, device)| Hlc {
        wall,
        counter: counter as u32,
        device,
    }))
}

async fn rekey_entity_uid(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: EntityKind,
    from: &str,
    to: &str,
    book_uid: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query("UPDATE sync_state_fields SET entity_uid = ?2 WHERE kind = ?1 AND entity_uid = ?3")
        .bind(kind.as_str())
        .bind(to)
        .bind(from)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "UPDATE sync_state_entities SET entity_uid = ?2, book_uid = COALESCE(?3, book_uid)
         WHERE kind = ?1 AND entity_uid = ?4",
    )
    .bind(kind.as_str())
    .bind(to)
    .bind(book_uid)
    .bind(from)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(super) async fn merge_entity_uid(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: EntityKind,
    from: &str,
    to: &str,
    book_uid: &str,
) -> Result<(), AppError> {
    if from == to {
        return Ok(());
    }
    let from_clock = entity_clock(tx, kind, from).await?;
    let to_clock = entity_clock(tx, kind, to).await?;
    match (from_clock, to_clock) {
        (Some(from_hlc), Some(to_hlc)) => {
            if from_hlc > to_hlc {
                sqlx::query("DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2")
                    .bind(kind.as_str())
                    .bind(to)
                    .execute(&mut **tx)
                    .await?;
                sqlx::query("DELETE FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2")
                    .bind(kind.as_str())
                    .bind(to)
                    .execute(&mut **tx)
                    .await?;
                rekey_entity_uid(tx, kind, from, to, Some(book_uid)).await?;
            } else {
                sqlx::query("DELETE FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2")
                    .bind(kind.as_str())
                    .bind(from)
                    .execute(&mut **tx)
                    .await?;
                sqlx::query("DELETE FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2")
                    .bind(kind.as_str())
                    .bind(from)
                    .execute(&mut **tx)
                    .await?;
            }
        }
        (Some(_), None) => rekey_entity_uid(tx, kind, from, to, Some(book_uid)).await?,
        _ => {}
    }
    Ok(())
}
