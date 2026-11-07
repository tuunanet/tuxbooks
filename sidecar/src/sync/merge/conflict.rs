//! Conflict recording: the diagnostic rows the merge keeps for races.

use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppError;
use crate::sync::clock::device_id;
use crate::sync::model::{EntityKind, Hlc, State};

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
    let loser =
        serde_json::Value::Object(loser.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
    // The local edit is the loser here and has no operation clock of its own
    // yet. Record the writing device and a current wall time so the row
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
        &serde_json::Value::String("deleted".into()),
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

/// Record the losing value of a race. ADR 0017 D1: every race has a
/// pre-decided winner, so this is a diagnostic, not a prompt — the row is
/// kept for support, and no review issue opens, for any kind.
#[allow(clippy::too_many_arguments)]
pub(super) async fn record_conflict(
    tx: &mut Transaction<'_, Sqlite>,
    kind: EntityKind,
    entity_uid: &str,
    field: &str,
    winner: &serde_json::Value,
    loser: &serde_json::Value,
    winner_hlc: &Hlc,
    loser_hlc: &Hlc,
) -> Result<(), AppError> {
    // Do not record a conflict when both sides say the same thing.
    if winner == loser {
        return Ok(());
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
