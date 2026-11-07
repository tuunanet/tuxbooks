//! The review list: what the user sees for each losing value the merge kept.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::error::AppError;

use super::super::model::EntityKind;
use super::super::store;
use super::{cutoff, parse_value, BOOK_UID_EXPR};

const LIST_LIMIT: i64 = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub id: i64,
    pub kind: String,
    pub entity_uid: String,
    /// The durable book the conflict belongs to, when one is known.
    pub book_uid: Option<String>,
    pub book_title: Option<String>,
    pub book_author: Option<String>,
    pub field: String,
    /// Readable name for the pseudo-fields the merge records: `__entity__`,
    /// `__deleted__`, and `__restore__`.
    pub field_label: Option<&'static str>,
    pub winner: Value,
    pub loser: Value,
    pub winner_device_id: String,
    pub winner_device_name: String,
    pub winner_wall: i64,
    pub winner_counter: i64,
    pub loser_device_id: String,
    pub loser_device_name: String,
    pub loser_wall: i64,
    pub loser_counter: i64,
    pub created_at: String,
    /// False when replaying the loser would be unsafe or meaningless; the
    /// reason explains the only supported choice, `keep_winner`.
    pub can_apply_loser: bool,
    pub apply_loser_blocked_reason: Option<&'static str>,
}

#[derive(Debug, sqlx::FromRow)]
struct ConflictRow {
    id: i64,
    kind: String,
    entity_uid: String,
    field: String,
    winner_json: String,
    loser_json: String,
    winner_wall: i64,
    winner_counter: i64,
    winner_dev: String,
    loser_wall: i64,
    loser_counter: i64,
    loser_dev: String,
    created_at: String,
    book_uid: Option<String>,
    book_title: Option<String>,
    book_author: Option<String>,
}

pub fn field_label(field: &str) -> Option<&'static str> {
    match field {
        "__entity__" => Some("whole entity"),
        "__deleted__" => Some("delete versus edit"),
        "__restore__" => Some("restore that lost"),
        _ => None,
    }
}

pub(super) fn device_name(root: Option<&Path>, cache: &mut HashMap<String, String>, id: &str) -> String {
    let Some(root) = root else {
        return id.to_string();
    };
    if let Some(name) = cache.get(id) {
        return name.clone();
    }
    let name = store::device_name(root, id);
    cache.insert(id.to_string(), name.clone());
    name
}

/// Open, unexpired conflicts newest first. Progress is diagnostic only and
/// never reaches this list. Book titles and device names come from the local
/// catalog and the sync folder; a missing folder only costs the names.
pub async fn list(pool: &SqlitePool, root: Option<&Path>) -> Result<Vec<SyncConflict>, AppError> {
    let rows: Vec<ConflictRow> = sqlx::query_as(&format!(
        r#"
        SELECT c.id, c.kind, c.entity_uid, c.field, c.winner_json, c.loser_json,
               c.winner_wall, c.winner_count AS winner_counter,
               c.winner_dev, c.loser_wall, c.loser_count AS loser_counter,
               c.loser_dev, c.created_at,
               {BOOK_UID_EXPR} AS book_uid,
               br.title AS book_title, br.author AS book_author
        FROM sync_conflicts c
        LEFT JOIN sync_state_entities e
               ON e.kind = c.kind AND e.entity_uid = c.entity_uid
        LEFT JOIN book_records br ON br.uid = {BOOK_UID_EXPR}
        WHERE c.resolved_at IS NULL AND c.created_at >= ?1
          AND c.kind <> 'progress'
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ?2
        "#
    ))
    .bind(cutoff())
    .bind(LIST_LIMIT)
    .fetch_all(pool)
    .await?;

    let mut names = HashMap::new();
    Ok(rows
        .into_iter()
        .map(|row| {
            let blocked = match EntityKind::parse(&row.kind) {
                Some(kind) => super::settle::apply_blocked_reason(kind, &row.field),
                None => Some("unknown entity kind"),
            };
            SyncConflict {
                id: row.id,
                kind: row.kind,
                entity_uid: row.entity_uid,
                book_uid: row.book_uid,
                book_title: row.book_title,
                book_author: row.book_author,
                field: row.field.clone(),
                field_label: field_label(&row.field),
                winner: parse_value(&row.winner_json),
                loser: parse_value(&row.loser_json),
                winner_device_name: device_name(root, &mut names, &row.winner_dev),
                winner_device_id: row.winner_dev,
                winner_wall: row.winner_wall,
                winner_counter: row.winner_counter,
                loser_device_name: device_name(root, &mut names, &row.loser_dev),
                loser_device_id: row.loser_dev,
                loser_wall: row.loser_wall,
                loser_counter: row.loser_counter,
                created_at: row.created_at,
                can_apply_loser: blocked.is_none(),
                apply_loser_blocked_reason: blocked,
            }
        })
        .collect())
}
