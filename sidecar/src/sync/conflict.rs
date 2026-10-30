//! Conflict review: read the losing values the merge kept, and let the user
//! settle one without changing the last-writer-wins rules.
//!
//! Resolving never patches only this machine. `apply_loser` publishes a normal
//! operation with a fresh clock, so every device replays it and converges. The
//! losing value stays in `sync_conflicts` until the row is resolved or the
//! 30-day window expires.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::SqlitePool;

use crate::error::AppError;

use super::capture;
use super::clock::now_rfc3339;
use super::merge::{self, Affected};
use super::model::EntityKind;
use super::store;

/// Matches the annotation and collection delete window: a losing value is
/// worth reviewing for the same 30 days, then it expires unread.
const CONFLICT_DAYS: i64 = 30;
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

pub fn field_label(field: &str) -> Option<&'static str> {
    match field {
        "__entity__" => Some("whole entity"),
        "__deleted__" => Some("delete versus edit"),
        "__restore__" => Some("restore that lost"),
        _ => None,
    }
}

/// Reasons a conflict can only be kept. Identity merges are deterministic and
/// replaying the losing uuid would resurrect an id every device already
/// collapsed. A whole-book conflict is settled through Reading history trash,
/// where the snapshot and the replacement identity are handled together.
pub fn apply_blocked_reason(kind: EntityKind, field: &str) -> Option<&'static str> {
    match (kind, field) {
        (EntityKind::BookIdentity, _) => {
            Some("book identity merges are deterministic and cannot be replayed")
        }
        (EntityKind::Book, "__entity__") => {
            Some("restore a forgotten book from Reading history instead")
        }
        _ => None,
    }
}

fn cutoff() -> String {
    (chrono::Utc::now() - chrono::Duration::days(CONFLICT_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Drop unresolved conflicts past the retention window and close the issues
/// that no longer have a conflict behind them. Called before every list and
/// every status refresh, so the count cannot drift from the rows.
pub async fn expire(pool: &SqlitePool) -> Result<u64, AppError> {
    let mut tx = pool.begin().await?;
    let deleted =
        sqlx::query("DELETE FROM sync_conflicts WHERE resolved_at IS NULL AND created_at < ?1")
            .bind(cutoff())
            .execute(&mut *tx)
            .await?;
    if deleted.rows_affected() > 0 {
        resolve_orphan_issues(&mut tx).await?;
    }
    tx.commit().await?;
    Ok(deleted.rows_affected())
}

/// The conflict issue key is stable for one (kind, entity, field), and several
/// losing writes share it. Close it only when no open conflict is left.
async fn resolve_orphan_issues(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE sync_issues SET resolved_at = ?1
        WHERE kind = 'conflict' AND resolved_at IS NULL
          AND issue_key NOT IN (
              SELECT 'conflict:' || kind || ':' || entity_uid || ':' || field
              FROM sync_conflicts WHERE resolved_at IS NULL
          )
        "#,
    )
    .bind(now_rfc3339())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn resolve_issue_if_clear(
    pool: &SqlitePool,
    kind: EntityKind,
    entity_uid: &str,
    field: &str,
) -> Result<(), AppError> {
    let issue_key = format!("conflict:{}:{entity_uid}:{field}", kind.as_str());
    sqlx::query(
        r#"
        UPDATE sync_issues SET resolved_at = ?1
        WHERE kind = 'conflict' AND resolved_at IS NULL AND issue_key = ?2
          AND NOT EXISTS (
              SELECT 1 FROM sync_conflicts
              WHERE kind = ?3 AND entity_uid = ?4 AND field = ?5
                AND resolved_at IS NULL
          )
        "#,
    )
    .bind(now_rfc3339())
    .bind(issue_key)
    .bind(kind.as_str())
    .bind(entity_uid)
    .bind(field)
    .execute(pool)
    .await?;
    Ok(())
}

type ConflictRow = (
    i64,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    String,
    i64,
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn device_name(root: Option<&Path>, cache: &mut HashMap<String, String>, id: &str) -> String {
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

fn parse_value(json: &str) -> Value {
    serde_json::from_str(json).unwrap_or(Value::Null)
}

/// Open, unexpired conflicts newest first. Book titles and device names come
/// from the local catalog and the sync folder; a missing folder only costs the
/// names and never the list.
pub async fn list(pool: &SqlitePool, root: Option<&Path>) -> Result<Vec<SyncConflict>, AppError> {
    let rows: Vec<ConflictRow> = sqlx::query_as(
        r#"
        SELECT c.id, c.kind, c.entity_uid, c.field, c.winner_json, c.loser_json,
               c.winner_wall, c.winner_count, c.winner_dev,
               c.loser_wall, c.loser_count, c.loser_dev, c.created_at,
               COALESCE(CASE WHEN c.kind = 'book' THEN c.entity_uid END, e.book_uid),
               br.title, br.author
        FROM sync_conflicts c
        LEFT JOIN sync_state_entities e
               ON e.kind = c.kind AND e.entity_uid = c.entity_uid
        LEFT JOIN book_records br
               ON br.uid = COALESCE(CASE WHEN c.kind = 'book' THEN c.entity_uid END,
                                    e.book_uid)
        WHERE c.resolved_at IS NULL AND c.created_at >= ?1
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ?2
        "#,
    )
    .bind(cutoff())
    .bind(LIST_LIMIT)
    .fetch_all(pool)
    .await?;

    let mut names = HashMap::new();
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                kind,
                entity_uid,
                field,
                winner_json,
                loser_json,
                winner_wall,
                winner_counter,
                winner_device_id,
                loser_wall,
                loser_counter,
                loser_device_id,
                created_at,
                book_uid,
                book_title,
                book_author,
            )| {
                let blocked = match EntityKind::parse(&kind) {
                    Some(kind) => apply_blocked_reason(kind, &field),
                    None => Some("unknown entity kind"),
                };
                SyncConflict {
                    id,
                    kind,
                    entity_uid,
                    book_uid,
                    book_title,
                    book_author,
                    field: field.clone(),
                    field_label: field_label(&field),
                    winner: parse_value(&winner_json),
                    loser: parse_value(&loser_json),
                    winner_device_name: device_name(root, &mut names, &winner_device_id),
                    winner_device_id,
                    winner_wall,
                    winner_counter,
                    loser_device_name: device_name(root, &mut names, &loser_device_id),
                    loser_device_id,
                    loser_wall,
                    loser_counter,
                    created_at,
                    can_apply_loser: blocked.is_none(),
                    apply_loser_blocked_reason: blocked,
                }
            },
        )
        .collect())
}

/// Load one unresolved conflict. A missing or already resolved id is `None`,
/// which the command surface reports as "nothing changed".
pub async fn open(pool: &SqlitePool, id: i64) -> Result<Option<OpenConflict>, AppError> {
    let row: Option<(String, String, String, String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT c.kind, c.entity_uid, c.field, c.loser_json,
               COALESCE(CASE WHEN c.kind = 'book' THEN c.entity_uid END, e.book_uid)
        FROM sync_conflicts c
        LEFT JOIN sync_state_entities e
               ON e.kind = c.kind AND e.entity_uid = c.entity_uid
        WHERE c.id = ?1 AND c.resolved_at IS NULL
        "#,
    )
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

pub async fn mark_resolved(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE sync_conflicts SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL",
    )
    .bind(id)
    .bind(now_rfc3339())
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Close the shared issue once the resolved row was its last open conflict.
pub async fn close_issue_if_settled(
    pool: &SqlitePool,
    conflict: &OpenConflict,
) -> Result<(), AppError> {
    resolve_issue_if_clear(pool, conflict.kind, &conflict.entity_uid, &conflict.field).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn pool_in(dir: &Path) -> SqlitePool {
        crate::db::connection::init_pool(&dir.join("t.db"))
            .await
            .unwrap()
    }

    async fn insert_conflict(
        pool: &SqlitePool,
        kind: &str,
        entity_uid: &str,
        field: &str,
        created_at: &str,
    ) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO sync_conflicts
                (kind, entity_uid, field, winner_json, loser_json,
                 winner_wall, winner_count, winner_dev,
                 loser_wall, loser_count, loser_dev, created_at)
             VALUES (?1, ?2, ?3, '\"winner\"', '\"loser\"', 2, 0, 'aaa',
                     1, 0, 'bbb', ?4)
             RETURNING id",
        )
        .bind(kind)
        .bind(entity_uid)
        .bind(field)
        .bind(created_at)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    fn now() -> String {
        now_rfc3339()
    }

    #[test]
    fn resolution_parses_only_the_two_supported_choices() {
        assert_eq!(
            Resolution::parse("keep_winner"),
            Some(Resolution::KeepWinner)
        );
        assert_eq!(
            Resolution::parse("apply_loser"),
            Some(Resolution::ApplyLoser)
        );
        assert_eq!(Resolution::parse("apply_winner"), None);
        assert_eq!(Resolution::parse(""), None);
    }

    #[test]
    fn pseudo_fields_have_readable_labels_and_plain_fields_do_not() {
        assert_eq!(field_label("__entity__"), Some("whole entity"));
        assert_eq!(field_label("__deleted__"), Some("delete versus edit"));
        assert_eq!(field_label("__restore__"), Some("restore that lost"));
        assert_eq!(field_label("note"), None);
    }

    #[test]
    fn identity_and_whole_book_conflicts_can_only_be_kept() {
        assert!(apply_blocked_reason(EntityKind::BookIdentity, "content_hash").is_some());
        assert!(apply_blocked_reason(EntityKind::Book, "__entity__").is_some());
        assert!(apply_blocked_reason(EntityKind::Book, "__deleted__").is_none());
        assert!(apply_blocked_reason(EntityKind::Annotation, "note").is_none());
    }

    #[test]
    fn missing_device_files_fall_back_to_the_stored_id() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let id = "a".repeat(32);
        assert_eq!(device_name(Some(root), &mut HashMap::new(), &id), id);
        assert_eq!(
            device_name(Some(root), &mut HashMap::new(), "../evil"),
            "../evil"
        );
        assert_eq!(device_name(None, &mut HashMap::new(), &id), id);

        let dir = root.join("devices").join(&id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("device.json"), b"{not json").unwrap();
        assert_eq!(device_name(Some(root), &mut HashMap::new(), &id), id);

        std::fs::write(
            dir.join("device.json"),
            serde_json::to_vec(&json!({
                "schema": 1,
                "device_id": id,
                "name": "  Laptop  ",
                "created_at": "2026-10-30T00:00:00.000Z"
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(device_name(Some(root), &mut HashMap::new(), &id), "Laptop");
    }

    #[tokio::test]
    async fn expire_drops_old_rows_and_their_issues_but_keeps_shared_keys() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let _old = insert_conflict(
            &pool,
            "annotation",
            "11",
            "note",
            "2000-01-01T00:00:00.000Z",
        )
        .await;
        let _fresh = insert_conflict(&pool, "annotation", "22", "note", &now()).await;
        for uid in ["11", "22"] {
            sqlx::query(
                "INSERT INTO sync_issues (issue_key, kind, detail)
                 VALUES (?1, 'conflict', 'kept one, discarded another')",
            )
            .bind(format!("conflict:annotation:{uid}:note"))
            .execute(&pool)
            .await
            .unwrap();
        }

        assert_eq!(expire(&pool).await.unwrap(), 1);
        let open: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(open, 1, "only the fresh row survives");
        let issues: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT issue_key, resolved_at FROM sync_issues ORDER BY issue_key")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(issues.len(), 2);
        assert!(issues[0].1.is_some(), "the expired key closes");
        assert!(issues[1].1.is_none(), "the live key stays open");
    }

    #[tokio::test]
    async fn open_skips_resolved_rows_and_rejects_unknown_kinds() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let id = insert_conflict(&pool, "annotation", "11", "note", &now()).await;
        assert!(open(&pool, id + 1).await.unwrap().is_none());
        let opened = open(&pool, id).await.unwrap().unwrap();
        assert_eq!(opened.field, "note");
        assert_eq!(opened.loser, json!("loser"));

        assert!(mark_resolved(&pool, id).await.unwrap());
        assert!(!mark_resolved(&pool, id).await.unwrap());
        assert!(open(&pool, id).await.unwrap().is_none());

        let bad = insert_conflict(&pool, "mystery", "11", "note", &now()).await;
        assert!(matches!(
            open(&pool, bad).await,
            Err(AppError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn list_reports_both_values_clocks_and_labels() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        insert_conflict(&pool, "progress", "33", "__entity__", &now()).await;
        sqlx::query("INSERT INTO book_records (uid, title, author) VALUES (?1, 'Book', 'Writer')")
            .bind("4".repeat(32))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sync_state_entities (kind, entity_uid, book_uid) VALUES ('progress', '55', ?1)")
            .bind("4".repeat(32))
            .execute(&pool)
            .await
            .unwrap();
        insert_conflict(&pool, "progress", "55", "__entity__", &now()).await;

        let listed = list(&pool, None).await.unwrap();
        assert_eq!(listed.len(), 2);
        let row = listed
            .iter()
            .find(|row| row.entity_uid == "55")
            .expect("joined row");
        assert_eq!(row.book_title.as_deref(), Some("Book"));
        assert_eq!(row.book_author.as_deref(), Some("Writer"));
        assert_eq!(row.book_uid.as_deref(), Some("4".repeat(32).as_str()));
        assert_eq!(row.field_label, Some("whole entity"));
        assert_eq!(row.winner, json!("winner"));
        assert_eq!(row.loser, json!("loser"));
        assert_eq!(row.winner_device_name, row.winner_device_id);
        assert_eq!((row.winner_wall, row.winner_counter), (2, 0));
        assert_eq!((row.loser_wall, row.loser_counter), (1, 0));
        assert!(row.can_apply_loser);
        assert!(row.apply_loser_blocked_reason.is_none());
    }

    #[tokio::test]
    async fn list_marks_identity_conflicts_as_keep_only() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        insert_conflict(
            &pool,
            "book_identity",
            &"5".repeat(64),
            "content_hash",
            &now(),
        )
        .await;
        let listed = list(&pool, None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].can_apply_loser);
        assert!(listed[0].apply_loser_blocked_reason.is_some());
    }

    #[tokio::test]
    async fn list_marks_unknown_kinds_as_keep_only() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        insert_conflict(&pool, "mystery", "77", "note", &now()).await;
        let listed = list(&pool, None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].can_apply_loser);
        assert_eq!(
            listed[0].apply_loser_blocked_reason,
            Some("unknown entity kind")
        );
    }

    #[tokio::test]
    async fn a_whole_entity_loser_that_is_not_an_object_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let root = store::resolve_root(tmp.path()).unwrap();
        let open = OpenConflict {
            kind: EntityKind::Progress,
            entity_uid: "aa".repeat(16),
            field: "__entity__".into(),
            book_uid: None,
            loser: json!("not an entity state"),
        };
        assert!(matches!(
            apply_loser(&pool, &root, &open).await,
            Err(AppError::InvalidInput(_))
        ));
    }
}
