//! Settlement: the two resolutions, the row they work from, and the replay of
//! a losing value as an ordinary write every device converges on.

use std::path::Path;

use serde_json::{Map, Value};
use sqlx::SqlitePool;

use crate::error::AppError;

use super::super::capture;
use super::super::clock::now_rfc3339;
use super::super::merge::{self, Affected};
use super::super::model::{conflict_issue_key, EntityKind};
use super::{parse_value, BOOK_UID_EXPR, NO_LIVE_CONFLICT};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    KeepWinner,
    ApplyLoser,
}

impl Resolution {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "keep_winner" => Some(Self::KeepWinner),
            "apply_loser" => Some(Self::ApplyLoser),
            _ => None,
        }
    }
}

/// The row a resolution works from, with the parsed loser value.
#[derive(Debug, Clone)]
pub struct OpenConflict {
    pub kind: EntityKind,
    pub entity_uid: String,
    pub field: String,
    pub book_uid: Option<String>,
    pub loser: Value,
}

/// Identity merges are deterministic, so replaying the losing uuid would
/// resurrect an id every device already collapsed.
pub fn apply_blocked_reason(kind: EntityKind, field: &str) -> Option<&'static str> {
    match (kind, field) {
        (EntityKind::BookIdentity, _) => {
            Some("book identity merges are deterministic and cannot be replayed")
        }
        _ => None,
    }
}

/// Load one unresolved conflict. A missing or already resolved id is `None`,
/// which the command surface reports as "nothing changed".
pub async fn open(pool: &SqlitePool, id: i64) -> Result<Option<OpenConflict>, AppError> {
    let row: Option<(String, String, String, String, Option<String>)> = sqlx::query_as(&format!(
        r#"
            SELECT c.kind, c.entity_uid, c.field, c.loser_json,
                   {BOOK_UID_EXPR} AS book_uid
            FROM sync_conflicts c
            LEFT JOIN sync_state_entities e
                   ON e.kind = c.kind AND e.entity_uid = c.entity_uid
            WHERE c.id = ?1 AND c.resolved_at IS NULL
            "#
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let Some((kind, entity_uid, field, loser_json, book_uid)) = row else {
        return Ok(None);
    };
    let Some(kind) = EntityKind::parse(&kind) else {
        return Err(AppError::InvalidInput(format!(
            "conflict {id} names an unknown entity kind"
        )));
    };
    Ok(Some(OpenConflict {
        kind,
        entity_uid,
        field,
        book_uid,
        loser: parse_value(&loser_json),
    }))
}

/// Publish the losing value as a fresh write. A plain field becomes one field
/// operation, a whole-entity conflict becomes one entity operation, and a
/// delete/restore conflict becomes the explicit restore op so a tombstone is
/// lifted rather than overwritten.
pub async fn apply_loser(
    pool: &SqlitePool,
    root: &Path,
    conflict: &OpenConflict,
) -> Result<Affected, AppError> {
    let book_uid = conflict.book_uid.as_deref();
    let fields = match conflict.field.as_str() {
        "__entity__" => conflict.loser.as_object().cloned().ok_or_else(|| {
            AppError::InvalidInput("conflict loser is not an entity state".into())
        })?,
        "__deleted__" | "__restore__" => {
            let (state, _) = merge::load_state(pool, conflict.kind, &conflict.entity_uid).await?;
            let mut prior: Map<String, Value> = state.into_iter().collect();
            if let Some(loser) = conflict.loser.as_object() {
                for (field, value) in loser {
                    prior.insert(field.clone(), value.clone());
                }
            }
            capture::write_restore(
                pool,
                root,
                conflict.kind,
                &conflict.entity_uid,
                book_uid,
                &prior,
            )
            .await?;
            return Ok(Affected {
                kind: conflict.kind,
                entity_uid: conflict.entity_uid.clone(),
                book_uid: conflict.book_uid.clone(),
            });
        }
        field => {
            let mut fields = Map::new();
            fields.insert(field.to_string(), conflict.loser.clone());
            fields
        }
    };
    capture::write_fields(
        pool,
        root,
        conflict.kind,
        &conflict.entity_uid,
        book_uid,
        fields,
    )
    .await?;
    Ok(Affected {
        kind: conflict.kind,
        entity_uid: conflict.entity_uid.clone(),
        book_uid: conflict.book_uid.clone(),
    })
}

/// Settle one row and close its shared issue in one transaction. The issue
/// closes only when no open conflict with the same key remains.
pub async fn settle(pool: &SqlitePool, id: i64, conflict: &OpenConflict) -> Result<bool, AppError> {
    let now = now_rfc3339();
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE sync_conflicts SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL",
    )
    .bind(id)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    let issue_key = conflict_issue_key(conflict.kind, &conflict.entity_uid, &conflict.field);
    sqlx::query(&format!(
        r#"
        UPDATE sync_issues SET resolved_at = ?1
        WHERE kind = 'conflict' AND resolved_at IS NULL AND issue_key = ?2
          AND {NO_LIVE_CONFLICT}
        "#
    ))
    .bind(&now)
    .bind(issue_key)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(updated)
}
