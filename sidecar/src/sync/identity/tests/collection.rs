//! Collection merge and canonical-entity-uid tests.

use super::*;
use crate::sync::kind::SyncIssueKind;

#[tokio::test]
async fn merging_collections_moves_fields_memberships_and_trash() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let loser = "b4".repeat(16);
    let winner = "b5".repeat(16);
    let book_uid = "b6".repeat(16);
    state_row(&pool, "collection", &loser, "", 0).await;
    state_field(&pool, "collection", &loser, "name", "\"Shelf\"", 10).await;
    state_row(
        &pool,
        "membership",
        &format!("{loser}:{book_uid}"),
        &book_uid,
        0,
    )
    .await;
    state_field(
        &pool,
        "membership",
        &format!("{loser}:{book_uid}"),
        "present",
        "true",
        10,
    )
    .await;
    sqlx::query(
        "INSERT INTO sync_trash
            (kind, entity_uid, book_uid, prior_json, deleted_wall, deleted_count,
             deleted_dev, deleted_at, expires_at)
         VALUES ('collection', ?1, NULL, '{\"name\":\"Shelf\"}', 1, 0, 'other',
                 '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')",
    )
    .bind(&loser)
    .execute(&pool)
    .await
    .unwrap();

    merge_collection_identity(&pool, &loser, &winner)
        .await
        .unwrap();

    let name: String = sqlx::query_scalar(
        "SELECT value_json FROM sync_state_fields
         WHERE kind = 'collection' AND entity_uid = ?1 AND field = 'name'",
    )
    .bind(&winner)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(name, "\"Shelf\"");
    let leftover: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_state_entities
         WHERE kind = 'collection' AND entity_uid = ?1",
    )
    .bind(&loser)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(leftover, 0);
    let membership_uid: String = sqlx::query_scalar(
        "SELECT entity_uid FROM sync_state_entities WHERE kind = 'membership' LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(membership_uid, format!("{winner}:{book_uid}"));
    let trash_owner: String =
        sqlx::query_scalar("SELECT entity_uid FROM sync_trash WHERE kind = 'collection'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(trash_owner, winner);
    assert_eq!(
        canonical_entity_uid(&pool, crate::sync::model::EntityKind::Collection, &loser)
            .await
            .unwrap(),
        winner
    );
}

#[tokio::test]
async fn canonical_entity_ids_follow_a_chain_and_issues_are_refreshed_in_place() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    for (loser, winner) in [("a", "b"), ("b", "c")] {
        sqlx::query(
            "INSERT INTO sync_entity_merges (kind, loser, winner) VALUES ('collection', ?1, ?2)",
        )
        .bind(loser)
        .bind(winner)
        .execute(&pool)
        .await
        .unwrap();
    }
    assert_eq!(
        canonical_entity_uid(&pool, crate::sync::model::EntityKind::Collection, "a")
            .await
            .unwrap(),
        "c"
    );

    record_issue(
        &pool,
        "one-key",
        SyncIssueKind::DuplicateBook,
        "first detail",
        None,
    )
    .await
    .unwrap();
    record_issue(
        &pool,
        "one-key",
        SyncIssueKind::HashFailed,
        "second detail",
        Some("ops/file.json"),
    )
    .await
    .unwrap();
    let rows: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT kind, detail, file_name FROM sync_issues")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 1, "one open issue per key");
    assert_eq!(rows[0].0, "hash_failed");
    assert_eq!(rows[0].1, "second detail");
    assert_eq!(rows[0].2.as_deref(), Some("ops/file.json"));

    touch_last_sync(&pool).await.unwrap();
    let last: String = sqlx::query_scalar("SELECT value FROM sync_meta WHERE key = ?1")
        .bind(crate::sync::clock::META_LAST_SYNC)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!last.is_empty());
}

#[tokio::test]
async fn merging_collections_keeps_the_newer_membership_clock() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let loser = "b7".repeat(16);
    let winner = "b8".repeat(16);
    let book_uid = "b9".repeat(16);
    state_row(&pool, "collection", &loser, "", 0).await;
    state_field(&pool, "collection", &loser, "name", "\"Shelf\"", 10).await;
    state_row(
        &pool,
        "membership",
        &format!("{loser}:{book_uid}"),
        &book_uid,
        100,
    )
    .await;
    state_field(
        &pool,
        "membership",
        &format!("{loser}:{book_uid}"),
        "present",
        "true",
        100,
    )
    .await;
    state_row(
        &pool,
        "membership",
        &format!("{winner}:{book_uid}"),
        &book_uid,
        300,
    )
    .await;
    state_field(
        &pool,
        "membership",
        &format!("{winner}:{book_uid}"),
        "present",
        "false",
        300,
    )
    .await;

    merge_collection_identity(&pool, &loser, &winner)
        .await
        .unwrap();

    let (state, _) = crate::sync::merge::load_state(
        &pool,
        crate::sync::model::EntityKind::Membership,
        &format!("{winner}:{book_uid}"),
    )
    .await
    .unwrap();
    assert_eq!(
        state.get("present"),
        Some(&serde_json::json!(false)),
        "the newer membership clock survives"
    );
    let old: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_state_entities
         WHERE kind = 'membership' AND entity_uid = ?1",
    )
    .bind(format!("{loser}:{book_uid}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(old, 0, "the losing membership row is removed");
}

#[tokio::test]
async fn merging_a_collection_with_itself_is_a_noop() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let uid = "c3".repeat(16);
    merge_collection_identity(&pool, &uid, &uid).await.unwrap();
    let merges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_entity_merges")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(merges, 0);
}
