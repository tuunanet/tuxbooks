use serde_json::json;
use sqlx::SqlitePool;
use std::path::Path;

use super::*;
use crate::sync::clock::now_rfc3339;
use crate::sync::model::{EntityKind, State};

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

async fn resolved_at(pool: &SqlitePool, id: i64) -> Option<String> {
    sqlx::query_scalar("SELECT resolved_at FROM sync_conflicts WHERE id = ?1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
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
async fn reconcile_closes_a_field_conflict_once_the_value_moves() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let id = insert_conflict(&pool, "annotation", "11", "note", &now_rfc3339()).await;
    insert_issue(&pool, "conflict:annotation:11:note").await;
    // The mirror still holds the winner, so the row is live.
    sqlx::query(
        "INSERT INTO sync_state_fields
            (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
         VALUES ('annotation', '11', 'note', '\"winner\"', 2, 0, 'aaa')",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(reconcile(&pool).await.unwrap(), 0);
    assert!(resolved_at(&pool, id).await.is_none());

    // A newer write moved the field and clock; the old row is stale.
    sqlx::query(
        "UPDATE sync_state_fields SET value_json = '\"newer\"', hlc_wall = 3
         WHERE kind = 'annotation' AND entity_uid = '11' AND field = 'note'",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(reconcile(&pool).await.unwrap(), 1);
    assert!(resolved_at(&pool, id).await.is_some());
    let issue: Option<String> = sqlx::query_scalar("SELECT resolved_at FROM sync_issues LIMIT 1")
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
    assert!(resolved_at(&pool, progress).await.is_none());

    sqlx::query(
        "UPDATE sync_state_entities SET hlc_wall = 9
         WHERE kind = 'progress' AND entity_uid = '22'",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(reconcile(&pool).await.unwrap(), 1);
    assert!(resolved_at(&pool, progress).await.is_some());
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
    assert!(resolved_at(&pool, id).await.is_some());
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
    assert!(resolved_at(&pool, id).await.is_some());
    let issue: Option<String> = sqlx::query_scalar("SELECT resolved_at FROM sync_issues LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(issue.is_some(), "the stale issue closes too");
}

#[tokio::test]
async fn conflicts_keep_a_row_but_never_open_an_issue() {
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
    let issues: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_issues WHERE kind = 'conflict' AND resolved_at IS NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(issues, 0, "races are diagnostics, never review rows");
}
