//! Conflict review: read the losing values the merge kept, and let the user
//! settle one without changing the last-writer-wins rules.
//!
//! Resolving never patches only this machine. `apply_loser` publishes a normal
//! operation with a fresh clock, so every device replays it and converges. The
//! losing value stays in `sync_conflicts` until the row is resolved or the
//! 30-day window expires.
//!
//! The queue is also reconciled against the mirror on every status refresh. A
//! conflict whose winner has been overwritten is no longer a choice, so it
//! closes on every device that replays the newer write. Progress conflicts are
//! recorded for diagnostics but never reach the review list or an issue.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppError;

use super::capture;
use super::clock::now_rfc3339;
use super::merge::{self, Affected};
use super::model::{conflict_issue_key, EntityKind, Hlc, TRASH_DAYS};
use super::store;

const LIST_LIMIT: i64 = 100;

/// The durable book a conflict belongs to. A `book` conflict keys on the
/// entity uid itself; every other kind reads the mirror row.
const BOOK_UID_EXPR: &str = "COALESCE(CASE WHEN c.kind = 'book' THEN c.entity_uid END, e.book_uid)";

/// An issue has no live conflict behind it. Shared by the reconcile and expiry
/// sweep and the single-key settlement path so the key join lives in one place.
const NO_LIVE_CONFLICT: &str = "NOT EXISTS (
    SELECT 1 FROM sync_conflicts c
    WHERE c.resolved_at IS NULL
      AND 'conflict:' || c.kind || ':' || c.entity_uid || ':' || c.field = sync_issues.issue_key
)";

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

fn cutoff() -> String {
    (chrono::Utc::now() - chrono::Duration::days(TRASH_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

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
                Some(kind) => apply_blocked_reason(kind, &row.field),
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

    async fn insert_issue(pool: &SqlitePool, issue_key: &str) {
        sqlx::query(
            "INSERT INTO sync_issues (issue_key, kind, detail)
             VALUES (?1, 'conflict', 'kept one, discarded another')",
        )
        .bind(issue_key)
        .execute(pool)
        .await
        .unwrap();
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
    fn identity_conflicts_can_only_be_kept() {
        assert!(apply_blocked_reason(EntityKind::BookIdentity, "content_hash").is_some());
        assert!(apply_blocked_reason(EntityKind::Annotation, "note").is_none());
        assert!(apply_blocked_reason(EntityKind::Progress, "__entity__").is_none());
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

    #[test]
    fn a_device_name_is_cached_for_the_rest_of_the_list() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let id = "b".repeat(32);
        let dir = root.join("devices").join(&id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("device.json"),
            serde_json::to_vec(&json!({
                "schema": 1,
                "device_id": id,
                "name": "Laptop",
                "created_at": "2026-10-30T00:00:00.000Z"
            }))
            .unwrap(),
        )
        .unwrap();

        let mut cache = HashMap::new();
        assert_eq!(device_name(Some(root), &mut cache, &id), "Laptop");
        // The cache answers after the file is gone, so one list reads each
        // device once even when both columns name it.
        std::fs::remove_file(dir.join("device.json")).unwrap();
        assert_eq!(device_name(Some(root), &mut cache, &id), "Laptop");
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
        let _fresh = insert_conflict(&pool, "annotation", "22", "note", &now_rfc3339()).await;
        insert_issue(&pool, "conflict:annotation:11:note").await;
        insert_issue(&pool, "conflict:annotation:22:note").await;

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
    async fn expire_closes_an_orphan_issue_without_an_expired_row() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        insert_issue(&pool, "conflict:annotation:33:note").await;

        assert_eq!(expire(&pool).await.unwrap(), 0);
        let resolved: Option<String> =
            sqlx::query_scalar("SELECT resolved_at FROM sync_issues LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(resolved.is_some(), "the orphan issue closes anyway");
    }

    #[tokio::test]
    async fn open_skips_resolved_rows_and_rejects_unknown_kinds() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let id = insert_conflict(&pool, "annotation", "11", "note", &now_rfc3339()).await;
        assert!(open(&pool, id + 1).await.unwrap().is_none());
        let opened = open(&pool, id).await.unwrap().unwrap();
        assert_eq!(opened.field, "note");
        assert_eq!(opened.loser, json!("loser"));

        assert!(settle(&pool, id, &opened).await.unwrap());
        assert!(!settle(&pool, id, &opened).await.unwrap());
        assert!(open(&pool, id).await.unwrap().is_none());

        let bad = insert_conflict(&pool, "mystery", "11", "note", &now_rfc3339()).await;
        assert!(matches!(
            open(&pool, bad).await,
            Err(AppError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn list_reports_both_values_clocks_and_labels_but_hides_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        sqlx::query("INSERT INTO book_records (uid, title, author) VALUES (?1, 'Book', 'Writer')")
            .bind("4".repeat(32))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sync_state_entities (kind, entity_uid, book_uid)
             VALUES ('annotation', '55', ?1)",
        )
        .bind("4".repeat(32))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
             VALUES ('annotation', '55', 'note', '\"winner\"', 2, 0, 'aaa')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO sync_state_entities
                (kind, entity_uid, hlc_wall, hlc_counter, hlc_device)
             VALUES ('progress', '66', 2, 0, 'aaa')",
        )
        .execute(&pool)
        .await
        .unwrap();
        insert_conflict(&pool, "annotation", "55", "note", &now_rfc3339()).await;
        insert_conflict(&pool, "progress", "66", "__entity__", &now_rfc3339()).await;

        let listed = list(&pool, None).await.unwrap();
        assert_eq!(listed.len(), 1, "progress stays out of the review list");
        let row = &listed[0];
        assert_eq!(row.book_title.as_deref(), Some("Book"));
        assert_eq!(row.book_author.as_deref(), Some("Writer"));
        assert_eq!(row.book_uid.as_deref(), Some("4".repeat(32).as_str()));
        assert_eq!(row.field_label, None);
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
        let uid = "5".repeat(64);
        insert_conflict(&pool, "book_identity", &uid, "content_hash", &now_rfc3339()).await;
        sqlx::query(
            "INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
             VALUES ('book_identity', ?1, 'content_hash', '\"winner\"', 2, 0, 'aaa')",
        )
        .bind(&uid)
        .execute(&pool)
        .await
        .unwrap();
        let listed = list(&pool, None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].can_apply_loser);
        assert!(listed[0].apply_loser_blocked_reason.is_some());
    }

    #[tokio::test]
    async fn list_marks_unknown_kinds_as_keep_only() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        insert_conflict(&pool, "mystery", "77", "note", &now_rfc3339()).await;
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

    #[tokio::test]
    async fn reconcile_closes_a_field_conflict_once_the_value_moves() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let id = insert_conflict(&pool, "annotation", "11", "note", &now_rfc3339()).await;
        insert_issue(&pool, "conflict:annotation:11:note").await;
        // The mirror still holds the winner, so the choice is live.
        sqlx::query(
            "INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
             VALUES ('annotation', '11', 'note', '\"winner\"', 2, 0, 'aaa')",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(reconcile(&pool).await.unwrap(), 0);
        assert_eq!(open(&pool, id).await.unwrap().unwrap().field, "note");

        // A newer write moved the field and clock; the old row is stale.
        sqlx::query(
            "UPDATE sync_state_fields SET value_json = '\"newer\"', hlc_wall = 3
             WHERE kind = 'annotation' AND entity_uid = '11' AND field = 'note'",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(reconcile(&pool).await.unwrap(), 1);
        assert!(open(&pool, id).await.unwrap().is_none());
        let issue: Option<String> =
            sqlx::query_scalar("SELECT resolved_at FROM sync_issues LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(issue.is_some(), "the issue closes with the row");
    }

    #[tokio::test]
    async fn reconcile_closes_an_entity_conflict_and_a_progress_issue() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let progress = insert_conflict(&pool, "progress", "22", "__entity__", &now_rfc3339()).await;
        insert_issue(&pool, "conflict:progress:22:__entity__").await;
        sqlx::query(
            "INSERT INTO sync_state_entities
                (kind, entity_uid, hlc_wall, hlc_counter, hlc_device)
             VALUES ('progress', '22', 2, 0, 'aaa')",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(reconcile(&pool).await.unwrap(), 0);
        assert!(open(&pool, progress).await.unwrap().is_some());

        sqlx::query(
            "UPDATE sync_state_entities SET hlc_wall = 9
             WHERE kind = 'progress' AND entity_uid = '22'",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(reconcile(&pool).await.unwrap(), 1);
        assert!(open(&pool, progress).await.unwrap().is_none());
        let open_issues: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_issues WHERE resolved_at IS NULL")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(open_issues, 0, "progress issues never stay open");
    }

    #[tokio::test]
    async fn reconcile_closes_a_tombstone_conflict_after_a_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let id = insert_conflict(&pool, "annotation", "33", "__deleted__", &now_rfc3339()).await;
        sqlx::query(
            "INSERT INTO sync_state_entities
                (kind, entity_uid, deleted, deleted_wall, deleted_count, deleted_dev)
             VALUES ('annotation', '33', 1, 2, 0, 'aaa')",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(reconcile(&pool).await.unwrap(), 0, "still deleted");

        sqlx::query(
            "UPDATE sync_state_entities SET deleted = 0,
                    restored_wall = 5, restored_count = 0, restored_dev = 'bbb'
             WHERE kind = 'annotation' AND entity_uid = '33'",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(reconcile(&pool).await.unwrap(), 1);
        assert!(open(&pool, id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_tombstone_conflict_from_an_older_delete_cycle_is_not_live() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let id = insert_conflict(&pool, "annotation", "34", "__deleted__", &now_rfc3339()).await;
        insert_issue(&pool, "conflict:annotation:34:__deleted__").await;
        // The conflict's winner is the delete at 2/aaa. A restore happened at
        // 5/bbb and a later delete at 9/ccc is the one now in effect.
        sqlx::query(
            "INSERT INTO sync_state_entities
                (kind, entity_uid, deleted, deleted_wall, deleted_count, deleted_dev,
                 restored_wall, restored_count, restored_dev)
             VALUES ('annotation', '34', 1, 9, 0, 'ccc', 5, 0, 'bbb')",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(
            reconcile(&pool).await.unwrap(),
            1,
            "the old delete cycle no longer wins"
        );
        assert!(open(&pool, id).await.unwrap().is_none());
        let issue: Option<String> =
            sqlx::query_scalar("SELECT resolved_at FROM sync_issues LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(issue.is_some(), "the stale issue closes too");
    }

    #[tokio::test]
    async fn progress_conflicts_keep_a_row_but_never_open_an_issue() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = pool_in(tmp.path()).await;
        let annotation_uid = "44".repeat(16);
        let progress_uid = "55".repeat(16);
        for (kind, uid) in [("annotation", &annotation_uid), ("progress", &progress_uid)] {
            sqlx::query(
                "INSERT INTO sync_state_entities
                    (kind, entity_uid, deleted, deleted_wall, deleted_count, deleted_dev)
                 VALUES (?1, ?2, 1, 2, 0, 'aaa')",
            )
            .bind(kind)
            .bind(uid)
            .execute(&pool)
            .await
            .unwrap();
        }
        let mut lost = crate::sync::model::State::new();
        lost.insert("note".into(), json!("lost edit"));
        super::super::merge::record_tombstone_conflict(
            &pool,
            EntityKind::Annotation,
            &annotation_uid,
            &lost,
        )
        .await
        .unwrap();
        super::super::merge::record_tombstone_conflict(
            &pool,
            EntityKind::Progress,
            &progress_uid,
            &crate::sync::model::State::new(),
        )
        .await
        .unwrap();

        let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(conflicts, 2, "both rows are kept for diagnostics");
        let issues: Vec<String> = sqlx::query_scalar("SELECT issue_key FROM sync_issues")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            issues,
            vec![format!("conflict:annotation:{annotation_uid}:__deleted__")]
        );
    }
}
