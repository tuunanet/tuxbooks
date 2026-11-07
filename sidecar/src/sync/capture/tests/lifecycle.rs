use serde_json::{Map, Value};

use crate::sync::capture::{drain, write_restore};
use crate::sync::model::EntityKind;
use crate::sync::store;

use super::support::{dirty_count, durable_book, insert_dirty, op_count, pool_in};

#[tokio::test]
async fn a_forget_without_a_portable_snapshot_keeps_the_tombstone_and_warns() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    insert_dirty(
        &pool,
        "book",
        &book_uid,
        "delete",
        Some(r#"{"snapshot_json":"{not json","replacement_book_uid":null}"#),
        None,
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 1);
    let kinds: Vec<String> = sqlx::query_scalar("SELECT kind FROM sync_issues ORDER BY kind")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        kinds,
        vec!["book_snapshot_invalid", "book_snapshot_missing"]
    );
    let deleted: i64 = sqlx::query_scalar(
        "SELECT deleted FROM sync_state_entities WHERE kind = 'book' AND entity_uid = ?1",
    )
    .bind(&book_uid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(deleted, 1);

    // The projection echo of that tombstone is not re-published.
    insert_dirty(
        &pool,
        "book",
        &book_uid,
        "delete",
        Some(r#"{"snapshot_json":null,"replacement_book_uid":null}"#),
        None,
    )
    .await;
    assert_eq!(
        drain(&pool, &root, &tmp.path().join("covers"), 10)
            .await
            .unwrap()
            .written,
        0
    );
    assert_eq!(dirty_count(&pool).await, 0);
}

#[tokio::test]
async fn a_discard_closes_the_shared_trash_and_its_echo_is_skipped() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let uid = "f".repeat(32);
    insert_dirty(
        &pool,
        "book",
        &uid,
        "upsert",
        None,
        Some(r#"{"action":"discard","snapshot_json":null}"#),
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    assert_eq!(
        drain(&pool, &root, &tmp.path().join("covers"), 10)
            .await
            .unwrap()
            .written,
        1
    );
    let (restored, discarded): (Option<String>, i64) =
        sqlx::query_as("SELECT restored_at, discarded FROM sync_book_trash WHERE book_uid = ?1")
            .bind(&uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(restored.is_some());
    assert_eq!(discarded, 1);

    insert_dirty(
        &pool,
        "book",
        &uid,
        "upsert",
        None,
        Some(r#"{"action":"discard","snapshot_json":null}"#),
    )
    .await;
    assert_eq!(
        drain(&pool, &root, &tmp.path().join("covers"), 10)
            .await
            .unwrap()
            .written,
        0,
        "the projection echo is dropped"
    );
}

#[tokio::test]
async fn a_local_edit_of_a_tombstoned_entity_becomes_a_conflict() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let annotation_uid = "ab".repeat(16);
    sqlx::query(
        "INSERT INTO sync_state_entities
            (kind, entity_uid, book_uid, deleted, deleted_wall, deleted_count, deleted_dev)
         VALUES ('annotation', ?1, ?2, 1, 100, 0, 'other')",
    )
    .bind(&annotation_uid)
    .bind(&book_uid)
    .execute(&pool)
    .await
    .unwrap();
    insert_dirty(
        &pool,
        "annotation",
        "1",
        "upsert",
        None,
        Some(&format!(
            r#"{{"book_uid":"{book_uid}","sync_uid":"{annotation_uid}","kind":"bookmark","note":"late"}}"#
        )),
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    let field: String = sqlx::query_scalar(
        "SELECT field FROM sync_conflicts WHERE entity_uid = ?1 AND field = '__deleted__'",
    )
    .bind(&annotation_uid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(field, "__deleted__");
    let (_, deleted) =
        crate::sync::merge::load_state(&pool, EntityKind::Annotation, &annotation_uid)
            .await
            .unwrap();
    assert!(deleted, "a later local edit must not resurrect the delete");
}

#[tokio::test]
async fn a_delete_with_no_prior_state_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let annotation_uid = "ba".repeat(16);
    insert_dirty(
        &pool,
        "annotation",
        "1",
        "delete",
        Some(&format!(
            r#"{{"book_uid":"{book_uid}","sync_uid":"{annotation_uid}","kind":"bookmark"}}"#
        )),
        None,
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(
        op_count(&pool).await,
        0,
        "nothing ever existed, so there is nothing to tombstone"
    );
    assert_eq!(dirty_count(&pool).await, 0);
}

#[tokio::test]
async fn write_restore_brings_a_tombstoned_entity_back_with_its_fields() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let annotation_uid = "cd".repeat(16);
    sqlx::query(
        "INSERT INTO sync_state_entities
            (kind, entity_uid, book_uid, deleted, deleted_wall, deleted_count, deleted_dev)
         VALUES ('annotation', ?1, ?2, 1, 100, 0, 'other')",
    )
    .bind(&annotation_uid)
    .bind(&book_uid)
    .execute(&pool)
    .await
    .unwrap();
    let mut prior = Map::new();
    prior.insert("kind".into(), Value::String("bookmark".into()));
    prior.insert("cfi".into(), Value::String("epubcfi(/6/4)".into()));
    prior.insert("note".into(), Value::String("restored".into()));
    let root = store::resolve_root(tmp.path()).unwrap();
    write_restore(
        &pool,
        &root,
        EntityKind::Annotation,
        &annotation_uid,
        Some(&book_uid),
        &prior,
    )
    .await
    .unwrap();
    let (state, deleted) =
        crate::sync::merge::load_state(&pool, EntityKind::Annotation, &annotation_uid)
            .await
            .unwrap();
    assert!(!deleted);
    assert_eq!(state.get("note"), Some(&serde_json::json!("restored")));
    let restore: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_ops WHERE deleted = 0")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(restore, 1);
}
