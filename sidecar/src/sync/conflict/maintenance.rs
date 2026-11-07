//! Queue maintenance: reconcile conflicts against the mirror and expire rows
//! past the retention window, closing the issues that lose their row.

use serde_json::Value;
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppError;

use super::super::clock::now_rfc3339;
use super::super::model::{EntityKind, Hlc};
use super::{cutoff, parse_value, NO_LIVE_CONFLICT};

/// True while the conflict's winner still describes the mirror. Once a newer
/// write moves the value or clock, the row records a choice the user can no
/// longer make.
async fn is_live(
    pool: &SqlitePool,
    kind: EntityKind,
    entity_uid: &str,
    field: &str,
    winner: &Value,
    winner_hlc: &Hlc,
) -> Result<bool, AppError> {
    match field {
        "__entity__" => {
            let row: Option<(i64, i64, String)> = sqlx::query_as(
                "SELECT hlc_wall, hlc_counter, hlc_device FROM sync_state_entities
                 WHERE kind = ?1 AND entity_uid = ?2",
            )
            .bind(kind.as_str())
            .bind(entity_uid)
            .fetch_optional(pool)
            .await?;
            Ok(row.is_some_and(|(wall, counter, device)| {
                wall == winner_hlc.wall
                    && counter == winner_hlc.counter as i64
                    && device == winner_hlc.device
            }))
        }
        "__deleted__" | "__restore__" => {
            // Live only while the same tombstone is still the one in effect.
            // A restore followed by a later delete is a new cycle, so the old
            // row no longer describes a choice the user can make.
            type Tombstone = (i64, i64, i64, String);
            let row: Option<Tombstone> = sqlx::query_as(
                "SELECT deleted, deleted_wall, deleted_count, deleted_dev
                 FROM sync_state_entities WHERE kind = ?1 AND entity_uid = ?2",
            )
            .bind(kind.as_str())
            .bind(entity_uid)
            .fetch_optional(pool)
            .await?;
            Ok(row.is_some_and(|(deleted, wall, counter, device)| {
                deleted != 0
                    && wall == winner_hlc.wall
                    && counter == winner_hlc.counter as i64
                    && device == winner_hlc.device
            }))
        }
        _ => {
            let row: Option<(String, i64, i64, String)> = sqlx::query_as(
                "SELECT value_json, hlc_wall, hlc_counter, hlc_device
                 FROM sync_state_fields WHERE kind = ?1 AND entity_uid = ?2 AND field = ?3",
            )
            .bind(kind.as_str())
            .bind(entity_uid)
            .bind(field)
            .fetch_optional(pool)
            .await?;
            Ok(row.is_some_and(|(json, wall, counter, device)| {
                parse_value(&json) == *winner
                    && wall == winner_hlc.wall
                    && counter == winner_hlc.counter as i64
                    && device == winner_hlc.device
            }))
        }
    }
}

/// Conflict issues that no longer have a live conflict, plus the progress
/// issues that never belong in the review. One query so both reconcile and
/// expiry can skip their write transaction when there is nothing to close.
async fn stale_issue_count(pool: &SqlitePool) -> Result<i64, AppError> {
    sqlx::query_scalar(&format!(
        r#"
        SELECT COUNT(*) FROM sync_issues
        WHERE kind = 'conflict' AND resolved_at IS NULL
          AND (issue_key LIKE 'conflict:progress:%' OR {NO_LIVE_CONFLICT})
        "#
    ))
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

async fn close_conflict_issues(
    tx: &mut Transaction<'_, Sqlite>,
    now: &str,
) -> Result<(), AppError> {
    sqlx::query(&format!(
        r#"
        UPDATE sync_issues SET resolved_at = ?1
        WHERE kind = 'conflict' AND resolved_at IS NULL
          AND (issue_key LIKE 'conflict:progress:%' OR {NO_LIVE_CONFLICT})
        "#
    ))
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Close every conflict whose winner no longer matches the mirror, then close
/// the issues that no longer have a live conflict. Runs on each status refresh
/// and before a list, so a device that replays another device's resolution
/// stops showing a stale choice.
pub async fn reconcile(pool: &SqlitePool) -> Result<u64, AppError> {
    type Row = (i64, String, String, String, String, i64, i64, String);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, kind, entity_uid, field, winner_json,
                winner_wall, winner_count, winner_dev
         FROM sync_conflicts WHERE resolved_at IS NULL",
    )
    .fetch_all(pool)
    .await?;

    let mut settled = Vec::new();
    for (id, kind, entity_uid, field, winner_json, wall, counter, device) in rows {
        let Some(kind) = EntityKind::parse(&kind) else {
            continue;
        };
        let winner_hlc = Hlc {
            wall,
            counter: counter as u32,
            device,
        };
        if !is_live(
            pool,
            kind,
            &entity_uid,
            &field,
            &parse_value(&winner_json),
            &winner_hlc,
        )
        .await?
        {
            settled.push(id);
        }
    }

    if settled.is_empty() && stale_issue_count(pool).await? == 0 {
        return Ok(0);
    }
    let now = now_rfc3339();
    let mut tx = pool.begin().await?;
    for id in &settled {
        sqlx::query(
            "UPDATE sync_conflicts SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL",
        )
        .bind(id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    close_conflict_issues(&mut tx, &now).await?;
    tx.commit().await?;
    Ok(settled.len() as u64)
}

/// Drop unresolved conflicts past the retention window and close the issues
/// that no longer have a live conflict. Called before every list and every
/// status refresh, so the count cannot drift from the rows.
pub async fn expire(pool: &SqlitePool) -> Result<u64, AppError> {
    let cutoff = cutoff();
    let expired: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL AND created_at < ?1",
    )
    .bind(&cutoff)
    .fetch_one(pool)
    .await?;
    // A crash can leave an issue behind with no row to expire. Close that too
    // instead of waiting for a future deletion.
    if expired == 0 && stale_issue_count(pool).await? == 0 {
        return Ok(0);
    }
    let now = now_rfc3339();
    let mut tx = pool.begin().await?;
    let deleted =
        sqlx::query("DELETE FROM sync_conflicts WHERE resolved_at IS NULL AND created_at < ?1")
            .bind(&cutoff)
            .execute(&mut *tx)
            .await?;
    close_conflict_issues(&mut tx, &now).await?;
    tx.commit().await?;
    Ok(deleted.rows_affected())
}
