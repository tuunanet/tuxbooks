use serde_json::json;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::Path;

use super::review::device_name;
use super::*;
use crate::error::AppError;
use crate::sync::clock::now_rfc3339;
use crate::sync::model::{EntityKind, State};
use crate::sync::store;

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
    let mut lost = State::new();
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
        &State::new(),
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
