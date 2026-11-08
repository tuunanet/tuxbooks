use crate::sync::capture::drain;
use crate::sync::store;

use super::support::{dirty_count, durable_book, insert_dirty, op_count, pool_in};

#[tokio::test]
async fn skips_a_state_row_when_its_book_is_gone() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    // No books row. A stale dirty marker must be dropped, not turned into
    // a shared delete.
    sqlx::query(
        "INSERT INTO sync_dirty (kind, entity_key, op, old_json)
         VALUES ('progress', '999', 'delete', '{}')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let root = store::resolve_root(tmp.path()).unwrap();
    let covers = tmp.path().join("covers");
    let report = drain(&pool, &root, &covers, 10).await.unwrap();
    assert_eq!(report.written, 0);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn an_unknown_dirty_kind_is_reported_and_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    insert_dirty(&pool, "mystery", "1", "upsert", None, Some("{}")).await;
    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 0);
    let issues: Vec<(String, String)> = sqlx::query_as("SELECT kind, detail FROM sync_issues")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].0, "invalid_dirty_kind");
    assert!(issues[0].1.contains("mystery"));
    assert_eq!(dirty_count(&pool).await, 0);
    assert_eq!(op_count(&pool).await, 0);
}

#[tokio::test]
async fn identity_markers_without_a_hash_or_uid_are_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    insert_dirty(&pool, "book_identity", "h1", "upsert", None, None).await;
    insert_dirty(&pool, "book_identity", "h2", "upsert", None, Some("{}")).await;
    insert_dirty(
        &pool,
        "book_identity",
        "h3",
        "upsert",
        None,
        Some(r#"{"content_hash":"a"}"#),
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 0);
    assert_eq!(dirty_count(&pool).await, 0);
}

#[tokio::test]
async fn identity_markers_publish_the_hash_alias() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let hash = "a".repeat(64);
    let uid = "b".repeat(32);
    insert_dirty(
        &pool,
        "book_identity",
        &hash,
        "upsert",
        None,
        Some(&format!(
            r#"{{"content_hash":"{hash}","book_uid":"{uid}"}}"#
        )),
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 1);
    let alias: String =
        sqlx::query_scalar("SELECT book_uid FROM sync_book_aliases WHERE content_hash = ?1")
            .bind(&hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(alias, uid);
}

#[tokio::test]
async fn incomplete_annotation_and_collection_markers_are_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;

    // No snapshot at all, and a marker that names no book.
    insert_dirty(&pool, "annotation", "1", "upsert", None, None).await;
    insert_dirty(&pool, "annotation", "2", "upsert", None, Some("{}")).await;
    // A delete needs a portable uid; an old row without one is dropped.
    insert_dirty(
        &pool,
        "annotation",
        "3",
        "delete",
        Some(&format!(r#"{{"book_uid":"{book_uid}"}}"#)),
        None,
    )
    .await;
    insert_dirty(&pool, "collection", "1", "upsert", None, None).await;
    insert_dirty(
        &pool,
        "collection",
        "2",
        "delete",
        Some(r#"{"name":"Shelf"}"#),
        None,
    )
    .await;

    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 0);
    assert_eq!(dirty_count(&pool).await, 0);
    assert_eq!(op_count(&pool).await, 0);
}

#[tokio::test]
async fn incomplete_book_state_and_book_markers_are_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;

    // The durable record exists, but the trigger snapshot did not survive.
    insert_dirty(&pool, "metadata", &book_uid, "upsert", None, None).await;
    insert_dirty(&pool, "opened", &book_uid, "upsert", None, None).await;
    // A whole-book marker with no payload cannot name a lifecycle change.
    insert_dirty(&pool, "book", &book_uid, "upsert", None, None).await;

    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 0);
    assert_eq!(dirty_count(&pool).await, 0);
}

#[tokio::test]
async fn incomplete_membership_markers_are_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;

    insert_dirty(&pool, "membership", "1", "upsert", None, None).await;
    insert_dirty(
        &pool,
        "membership",
        "2",
        "upsert",
        None,
        Some(r#"{"collection_id":1,"present":true}"#),
    )
    .await;
    insert_dirty(
        &pool,
        "membership",
        "3",
        "upsert",
        None,
        Some(&format!(r#"{{"book_uid":"{book_uid}","present":true}}"#)),
    )
    .await;

    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 0);
    assert_eq!(dirty_count(&pool).await, 0);
}
