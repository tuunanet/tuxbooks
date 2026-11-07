//! What the merge records when a write loses: the diagnostic rows and the
//! review issues behind them.

use serde_json::{json, Map};

use super::support::{create_book, op};
use crate::sync::clock::device_id;
use crate::sync::merge::{apply_op, load_state, record_tombstone_conflict};
use crate::sync::model::{EntityKind, State};

#[tokio::test]
async fn older_field_does_not_overwrite_and_is_kept_as_conflict() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let uid = "c".repeat(32);
    let mut newer = op(
        EntityKind::Annotation,
        &uid,
        &book,
        json!({"note": "newer"}),
    );
    newer.hlc.wall = 200;
    apply_op(&pool, &newer, "a.json").await.unwrap();
    let mut older = op(
        EntityKind::Annotation,
        &uid,
        &book,
        json!({"note": "older"}),
    );
    older.hlc.wall = 100;
    apply_op(&pool, &older, "b.json").await.unwrap();
    let (state, _) = load_state(&pool, EntityKind::Annotation, &uid)
        .await
        .unwrap();
    assert_eq!(state.get("note"), Some(&json!("newer")));
    let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(conflicts, 1);
}

#[tokio::test]
async fn a_restore_older_than_the_tombstone_is_kept_as_a_conflict() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let uid = "f3".repeat(16);
    let mut delete = op(EntityKind::Annotation, &uid, &book, json!({}));
    delete.deleted = true;
    delete.fields = Map::new();
    delete.hlc.wall = 200;
    apply_op(&pool, &delete, "a.json").await.unwrap();

    let mut restore = op(
        EntityKind::Annotation,
        &uid,
        &book,
        json!({"note": "late restore"}),
    );
    restore.restore = true;
    restore.hlc.wall = 100;
    apply_op(&pool, &restore, "b.json").await.unwrap();

    let (_, deleted) = load_state(&pool, EntityKind::Annotation, &uid)
        .await
        .unwrap();
    assert!(deleted, "an older restore cannot resurrect the delete");
    let conflicts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_conflicts WHERE entity_uid = ?1 AND field = '__restore__'",
    )
    .bind(&uid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(conflicts, 1);
}

#[tokio::test]
async fn identical_older_values_and_repeated_conflicts_stay_quiet() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;

    // An identical older progress op is not a conflict. Entity mode keeps
    // the whole locator, so the comparison is against the full field set.
    let progress = "f5".repeat(16);
    let locator = |page: u64| {
        json!({
            "chapter_href": "c.xhtml",
            "cfi": "epubcfi(/6/4)",
            "character_offset": 0,
            "page_number": page,
            "scroll_offset": 0.0,
            "progress_percent": 60.0,
            "locator": "x",
            "progression": 0.6,
            "locations": "{}",
            "engine": "readium",
            "schema_version": 2
        })
    };
    let mut newer = op(EntityKind::Progress, &progress, &book, locator(4));
    newer.hlc.wall = 200;
    apply_op(&pool, &newer, "a.json").await.unwrap();
    let mut identical = op(EntityKind::Progress, &progress, &book, locator(4));
    identical.hlc.wall = 100;
    apply_op(&pool, &identical, "b.json").await.unwrap();
    let conflicts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts WHERE entity_uid = ?1")
            .bind(&progress)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(conflicts, 0);

    // Two losing edits share one open issue and keep both conflict rows.
    let annotation = "f6".repeat(16);
    let mut newest = op(
        EntityKind::Annotation,
        &annotation,
        &book,
        json!({"note": "newest"}),
    );
    newest.hlc.wall = 300;
    apply_op(&pool, &newest, "c.json").await.unwrap();
    for (wall, note) in [(200, "older one"), (100, "older two")] {
        let mut older = op(
            EntityKind::Annotation,
            &annotation,
            &book,
            json!({"note": note}),
        );
        older.hlc.wall = wall;
        apply_op(&pool, &older, "d.json").await.unwrap();
    }
    let conflicts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts WHERE entity_uid = ?1")
            .bind(&annotation)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(conflicts, 2);
    let issues: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_issues WHERE issue_key LIKE ?1 AND resolved_at IS NULL",
    )
    .bind(format!("conflict:annotation:{annotation}:note"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(issues, 1, "one issue per field, refreshed in place");
}

#[tokio::test]
async fn a_tombstone_conflict_for_a_live_entity_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let uid = "c1".repeat(16);
    apply_op(
        &pool,
        &op(EntityKind::Annotation, &uid, &book, json!({"note": "live"})),
        "a.json",
    )
    .await
    .unwrap();
    let mut state = State::new();
    state.insert("note".into(), json!("late"));
    record_tombstone_conflict(&pool, EntityKind::Annotation, &uid, &state)
        .await
        .unwrap();
    let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_conflicts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(conflicts, 0);
}

#[tokio::test]
async fn a_local_edit_after_a_tombstone_records_its_device_and_time() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let book = create_book(&pool).await;
    let uid = "c4".repeat(16);
    apply_op(
        &pool,
        &op(EntityKind::Annotation, &uid, &book, json!({"note": "live"})),
        "a.json",
    )
    .await
    .unwrap();
    let mut delete = op(EntityKind::Annotation, &uid, &book, json!({}));
    delete.deleted = true;
    delete.fields = Map::new();
    delete.hlc.wall = 200;
    apply_op(&pool, &delete, "b.json").await.unwrap();

    let mut state = State::new();
    state.insert("note".into(), json!("late edit"));
    record_tombstone_conflict(&pool, EntityKind::Annotation, &uid, &state)
        .await
        .unwrap();

    let row: (String, i64, i64, String) = sqlx::query_as(
        "SELECT loser_dev, loser_wall, loser_count, field FROM sync_conflicts
         WHERE entity_uid = ?1",
    )
    .bind(&uid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.3, "__deleted__");
    assert_eq!(row.0, device_id(&pool).await.unwrap());
    assert!(row.1 > 0, "the losing edit has a real wall time");
    assert_eq!(row.2, 0);
}
