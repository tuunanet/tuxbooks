//! Conflict recording: the rows the merge keeps for diagnostics and review.

use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppError;
use crate::sync::clock::device_id;
use crate::sync::model::{conflict_issue_key, EntityKind, Hlc, State};

pub(super) fn truncate(value: &str, max_chars: usize) -> String {
    let mut text: String = value.chars().take(max_chars).collect();
    if text.len() < value.len() {
        text.push('…');
    }
    text
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
    let loser = serde_json::Value::Object(loser.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
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

#[cfg(test)]
mod tests {
    use super::truncate;

    #[test]
    fn truncate_marks_a_shortened_value() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }
}
