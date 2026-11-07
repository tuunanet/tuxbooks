//! Field-mode and entity-mode merge semantics: what a newer, older, or
//! repeated operation does to the shared mirror.

use serde_json::{json, Map, Value};

use super::support::{create_book, op, rand_id};
use crate::error::AppError;
use crate::sync::merge::{apply_op, load_state};
use crate::sync::model::EntityKind;

#[tokio::test]
async fn annotation_fields_merge_independently() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let uid = "a".repeat(32);
    let mut first = op(
        EntityKind::Annotation,
        &uid,
        &book,
        json!({"kind": "highlight", "text": "passage", "note": "one"}),
    );
    first.hlc.wall = 100;
    apply_op(&pool, &first, "a.json").await.unwrap();

    let mut second = op(EntityKind::Annotation, &uid, &book, json!({"note": "two"}));
    second.hlc.wall = 101;
    apply_op(&pool, &second, "b.json").await.unwrap();

    let (state, deleted) = load_state(&pool, EntityKind::Annotation, &uid)
        .await
        .unwrap();
    assert!(!deleted);
    assert_eq!(state.get("note"), Some(&json!("two")));
    assert_eq!(state.get("text"), Some(&json!("passage")));
}

#[tokio::test]
async fn delete_wins_and_restore_is_explicit() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let uid = "d".repeat(32);
    let mut create = op(
        EntityKind::Annotation,
        &uid,
        &book,
        json!({"kind": "bookmark", "cfi": "x", "note": "keep"}),
    );
    create.hlc.wall = 100;
    apply_op(&pool, &create, "a.json").await.unwrap();

    let mut delete = op(EntityKind::Annotation, &uid, &book, json!({}));
    delete.deleted = true;
    delete.fields = Map::new();
    delete.hlc.wall = 200;
    apply_op(&pool, &delete, "b.json").await.unwrap();
    let (_, deleted) = load_state(&pool, EntityKind::Annotation, &uid)
        .await
        .unwrap();
    assert!(deleted);

    let mut concurrent = op(
        EntityKind::Annotation,
        &uid,
        &book,
        json!({"note": "edited elsewhere"}),
    );
    concurrent.hlc.wall = 300;
    apply_op(&pool, &concurrent, "c.json").await.unwrap();
    let (_, deleted) = load_state(&pool, EntityKind::Annotation, &uid)
        .await
        .unwrap();
    assert!(deleted, "a concurrent edit must not resurrect a delete");

    let mut restore = op(
        EntityKind::Annotation,
        &uid,
        &book,
        json!({"kind": "bookmark", "cfi": "x", "note": "back"}),
    );
    restore.restore = true;
    restore.hlc.wall = 400;
    apply_op(&pool, &restore, "d.json").await.unwrap();
    let (state, deleted) = load_state(&pool, EntityKind::Annotation, &uid)
        .await
        .unwrap();
    assert!(!deleted);
    assert_eq!(state.get("note"), Some(&json!("back")));
}

#[tokio::test]
async fn progress_replaces_the_whole_locator() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let uid = "e".repeat(32);
    let all = |page: u64, cfi: &str| {
        json!({
            "chapter_href": "c.xhtml",
            "cfi": cfi,
            "character_offset": 0,
            "page_number": page,
            "scroll_offset": 0.0,
            "progress_percent": 10.0,
            "locator": "x",
            "progression": 0.1,
            "locations": "{}",
            "engine": "readium",
            "schema_version": 2
        })
    };
    let mut first = op(EntityKind::Progress, &uid, &book, all(1, "a"));
    first.hlc.wall = 100;
    apply_op(&pool, &first, "a.json").await.unwrap();
    let mut second = op(EntityKind::Progress, &uid, &book, all(2, "b"));
    second.hlc.wall = 101;
    apply_op(&pool, &second, "b.json").await.unwrap();
    let (state, _) = load_state(&pool, EntityKind::Progress, &uid).await.unwrap();
    assert_eq!(state.get("page_number"), Some(&json!(2)));
    assert_eq!(state.get("cfi"), Some(&json!("b")));
}

#[tokio::test]
async fn a_delete_keeps_the_prior_payload_and_ignores_stale_or_repeated_deletes() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let uid = "7".repeat(32);
    let mut delete = op(EntityKind::Annotation, &uid, &book, json!({}));
    delete.deleted = true;
    delete.fields = Map::new();
    delete.hlc.wall = 100;
    delete.prior = Some(
        json!({"kind": "bookmark", "cfi": "x", "note": "keep"})
            .as_object()
            .cloned()
            .unwrap(),
    );
    apply_op(&pool, &delete, "a.json").await.unwrap();
    let prior_json: String =
        sqlx::query_scalar("SELECT prior_json FROM sync_trash WHERE entity_uid = ?1")
            .bind(&uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    let prior: Value = serde_json::from_str(&prior_json).unwrap();
    assert_eq!(prior["note"], json!("keep"));

    // A repeat of the delete is a no-op, not a second trash entry.
    let mut again = delete.clone();
    again.op_id = format!("{:032x}", rand_id());
    again.hlc.wall = 200;
    apply_op(&pool, &again, "b.json").await.unwrap();
    let entries: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_trash WHERE entity_uid = ?1")
        .bind(&uid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(entries, 1);

    // An entity-mode delete older than the last locator is ignored.
    let progress = "8".repeat(32);
    let mut newer = op(
        EntityKind::Progress,
        &progress,
        &book,
        json!({"progress_percent": 50.0}),
    );
    newer.hlc.wall = 200;
    apply_op(&pool, &newer, "c.json").await.unwrap();
    let mut stale = op(EntityKind::Progress, &progress, &book, json!({}));
    stale.deleted = true;
    stale.fields = Map::new();
    stale.hlc.wall = 150;
    apply_op(&pool, &stale, "d.json").await.unwrap();
    let (state, deleted) = load_state(&pool, EntityKind::Progress, &progress)
        .await
        .unwrap();
    assert!(!deleted);
    assert_eq!(state.get("progress_percent"), Some(&json!(50.0)));

    // A delete older than an explicit restore is ignored.
    let restored = "9".repeat(32);
    apply_op(
        &pool,
        &op(
            EntityKind::Annotation,
            &restored,
            &book,
            json!({"note": "back"}),
        ),
        "e.json",
    )
    .await
    .unwrap();
    sqlx::query(
        "UPDATE sync_state_entities SET restored_wall = 500, restored_count = 0,
         restored_dev = 'other' WHERE kind = 'annotation' AND entity_uid = ?1",
    )
    .bind(&restored)
    .execute(&pool)
    .await
    .unwrap();
    let mut old_delete = op(EntityKind::Annotation, &restored, &book, json!({}));
    old_delete.deleted = true;
    old_delete.fields = Map::new();
    old_delete.hlc.wall = 400;
    apply_op(&pool, &old_delete, "f.json").await.unwrap();
    let (_, deleted) = load_state(&pool, EntityKind::Annotation, &restored)
        .await
        .unwrap();
    assert!(!deleted);
}

#[tokio::test]
async fn older_entity_ops_and_equal_values_do_not_create_conflicts() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let progress = "a1".repeat(16);
    let mut newer = op(
        EntityKind::Progress,
        &progress,
        &book,
        json!({"progress_percent": 60.0}),
    );
    newer.hlc.wall = 200;
    apply_op(&pool, &newer, "a.json").await.unwrap();
    let mut older = op(
        EntityKind::Progress,
        &progress,
        &book,
        json!({"progress_percent": 10.0}),
    );
    older.hlc.wall = 100;
    apply_op(&pool, &older, "b.json").await.unwrap();
    let (state, _) = load_state(&pool, EntityKind::Progress, &progress)
        .await
        .unwrap();
    assert_eq!(state.get("progress_percent"), Some(&json!(60.0)));
    let entity_conflict: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_conflicts WHERE entity_uid = ?1 AND field = '__entity__'",
    )
    .bind(&progress)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(entity_conflict, 1);

    // The same value from an older clock is not a conflict at all.
    let annotation = "b1".repeat(16);
    let mut first = op(
        EntityKind::Annotation,
        &annotation,
        &book,
        json!({"note": "same"}),
    );
    first.hlc.wall = 200;
    apply_op(&pool, &first, "c.json").await.unwrap();
    let mut same = op(
        EntityKind::Annotation,
        &annotation,
        &book,
        json!({"note": "same"}),
    );
    same.hlc.wall = 100;
    apply_op(&pool, &same, "d.json").await.unwrap();
    let conflicts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts WHERE entity_uid = ?1")
            .bind(&annotation)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(conflicts, 0);
}

#[tokio::test]
async fn a_newer_progress_delete_tombstones_the_locator() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let uid = "f4".repeat(16);
    let mut progress = op(
        EntityKind::Progress,
        &uid,
        &book,
        json!({"progress_percent": 30.0}),
    );
    progress.hlc.wall = 100;
    apply_op(&pool, &progress, "a.json").await.unwrap();

    let mut delete = op(EntityKind::Progress, &uid, &book, json!({}));
    delete.deleted = true;
    delete.fields = Map::new();
    delete.hlc.wall = 200;
    apply_op(&pool, &delete, "b.json").await.unwrap();

    let (_, deleted) = load_state(&pool, EntityKind::Progress, &uid).await.unwrap();
    assert!(deleted);
}

#[tokio::test]
async fn a_membership_op_without_a_colon_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let bad = op(
        EntityKind::Membership,
        "no-colon",
        &book,
        json!({"present": true}),
    );
    let err = apply_op(&pool, &bad, "a.json").await.unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");
}

#[tokio::test]
async fn applying_an_op_with_a_merged_book_uid_uses_the_winner() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let loser = "f7".repeat(16);
    let winner = "f8".repeat(16);
    sqlx::query("INSERT INTO sync_book_merges (loser, winner) VALUES (?1, ?2)")
        .bind(&loser)
        .bind(&winner)
        .execute(&pool)
        .await
        .unwrap();
    let affected = apply_op(
        &pool,
        &op(
            EntityKind::Annotation,
            &"f9".repeat(16),
            &loser,
            json!({"note": "via alias"}),
        ),
        "a.json",
    )
    .await
    .unwrap();
    assert_eq!(affected[0].book_uid.as_deref(), Some(winner.as_str()));
}

#[tokio::test]
async fn applying_a_collection_op_uses_the_merged_entity_uid() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let loser = "e1".repeat(16);
    let winner = "e2".repeat(16);
    sqlx::query(
        "INSERT INTO sync_entity_merges (kind, loser, winner) VALUES ('collection', ?1, ?2)",
    )
    .bind(&loser)
    .bind(&winner)
    .execute(&pool)
    .await
    .unwrap();
    let affected = apply_op(
        &pool,
        &op(EntityKind::Collection, &loser, "", json!({"name": "Shelf"})),
        "a.json",
    )
    .await
    .unwrap();
    assert_eq!(affected[0].entity_uid, winner);
    let (state, _) = load_state(&pool, EntityKind::Collection, &winner)
        .await
        .unwrap();
    assert_eq!(state.get("name"), Some(&json!("Shelf")));
}
