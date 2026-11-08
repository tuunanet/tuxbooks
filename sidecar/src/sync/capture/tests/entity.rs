use serde_json::Value;

use crate::error::AppError;
use crate::sync::capture::drain;
use crate::sync::model::EntityKind;
use crate::sync::store;

use super::support::{dirty_count, durable_book, insert_dirty, pool_in};

#[tokio::test]
async fn annotation_capture_uses_the_durable_uid_without_a_hash_binding() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let (book_id, _) = crate::repository::books::upsert_book(
        &pool,
        &crate::domain::NewBook {
            path: "/tmp/unhashed.epub".into(),
            title: "Unhashed".into(),
            subtitle: None,
            author: None,
            authors: Vec::new(),
            subjects: Vec::new(),
            publisher: None,
            language: None,
            isbn: None,
            description: None,
            publication_date: None,
            series: None,
            series_index: None,
            cover_path: None,
            file_size: 0,
            file_mtime: 0,
        },
    )
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO annotations (book_uid, kind, cfi, text)
         SELECT uid, 'bookmark', 'epubcfi(/6/4)', 'before the hash' FROM book_records WHERE id = ?1",
    )
    .bind(book_id)
    .execute(&pool)
    .await
    .unwrap();

    let marker: String =
        sqlx::query_scalar("SELECT new_json FROM sync_dirty WHERE kind = 'annotation' LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        marker.contains("\"book_uid\""),
        "the trigger carries the durable key: {marker}"
    );

    let root = store::resolve_root(tmp.path()).unwrap();
    let covers = tmp.path().join("covers");
    let report = drain(&pool, &root, &covers, 10).await.unwrap();
    assert_eq!(report.written, 1, "capture does not wait for a binding");
    let bindings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_book_bindings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(bindings, 0);
}

#[tokio::test]
async fn an_old_annotation_marker_resolves_through_the_numeric_book_id() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, record_id) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let annotation_uid = "d".repeat(32);
    insert_dirty(
        &pool,
        "annotation",
        "42",
        "upsert",
        None,
        Some(&format!(
            r#"{{"book_id":{record_id},"sync_uid":"{annotation_uid}","kind":"bookmark","cfi":"epubcfi(/6/4)"}}"#
        )),
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 1);
    let (state, deleted) =
        crate::sync::merge::load_state(&pool, EntityKind::Annotation, &annotation_uid)
            .await
            .unwrap();
    assert!(!deleted);
    assert_eq!(state.get("cfi"), Some(&serde_json::json!("epubcfi(/6/4)")));
    let op_book_uid: Option<String> =
        sqlx::query_scalar("SELECT book_uid FROM sync_ops WHERE entity_uid = ?1")
            .bind(&annotation_uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(op_book_uid.as_deref(), Some(book_uid.as_str()));
}

#[tokio::test]
async fn an_annotation_marker_with_no_book_or_no_portable_id_is_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    // Old marker whose numeric book id has no durable record.
    insert_dirty(
        &pool,
        "annotation",
        "1",
        "upsert",
        None,
        Some(r#"{"book_id":999,"sync_uid":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}"#),
    )
    .await;
    // A delete marker with no portable uid cannot name the shared entity.
    insert_dirty(
        &pool,
        "annotation",
        "2",
        "delete",
        Some(r#"{"book_id":1,"kind":"bookmark"}"#),
        None,
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
async fn an_annotation_marker_with_a_bad_key_is_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    insert_dirty(
        &pool,
        "annotation",
        "not-a-number",
        "upsert",
        None,
        Some(&format!(r#"{{"book_uid":"{book_uid}"}}"#)),
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    let err = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");
}

#[tokio::test]
async fn a_collection_marker_mints_a_portable_uid_once() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let id: i64 =
        sqlx::query_scalar("INSERT INTO collections (name) VALUES ('Shelf') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
    // The insert trigger queued its own collection marker.
    sqlx::query("DELETE FROM sync_dirty")
        .execute(&pool)
        .await
        .unwrap();
    insert_dirty(
        &pool,
        "collection",
        &id.to_string(),
        "upsert",
        None,
        Some(r#"{"name":"Shelf"}"#),
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(report.written, 1);
    let sync_uid: String = sqlx::query_scalar("SELECT sync_uid FROM collections WHERE id = ?1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sync_uid.len(), 32);
    let (state, _) = crate::sync::merge::load_state(&pool, EntityKind::Collection, &sync_uid)
        .await
        .unwrap();
    assert_eq!(state.get("name"), Some(&serde_json::json!("Shelf")));
}

#[tokio::test]
async fn a_collection_marker_with_a_bad_key_is_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    insert_dirty(
        &pool,
        "collection",
        "nope",
        "upsert",
        None,
        Some(r#"{"name":"Shelf"}"#),
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    let err = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");
}

#[tokio::test]
async fn metadata_capture_publishes_a_cover_blob_and_reports_an_unreadable_one() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let covers = tmp.path().join("covers");
    std::fs::create_dir_all(&covers).unwrap();

    let good = "0123456789abcdef.png";
    std::fs::write(covers.join(good), b"cover bytes").unwrap();
    let bad = "fedcba9876543210.png";
    std::fs::create_dir_all(covers.join(bad)).unwrap();

    insert_dirty(
        &pool,
        "metadata",
        &book_uid,
        "upsert",
        None,
        Some(&format!(
            r#"{{"title":"One","cover_path":"{}"}}"#,
            covers.join(good).display()
        )),
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    drain(&pool, &root, &covers, 10).await.unwrap();
    assert!(root.join("blobs/covers").join(good).exists());

    insert_dirty(
        &pool,
        "metadata",
        &book_uid,
        "upsert",
        None,
        Some(&format!(
            r#"{{"title":"Two","cover_path":"{}"}}"#,
            covers.join(bad).display()
        )),
    )
    .await;
    drain(&pool, &root, &covers, 10).await.unwrap();
    let issue: String =
        sqlx::query_scalar("SELECT detail FROM sync_issues WHERE kind = 'cover_blob_failed'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(issue.contains(bad), "{issue}");
    let (state, _) = crate::sync::merge::load_state(&pool, EntityKind::Metadata, &book_uid)
        .await
        .unwrap();
    assert_eq!(
        state.get("cover_path"),
        Some(&Value::String(bad.to_string())),
        "the metadata edit still applies without the blob"
    );
}

#[tokio::test]
async fn membership_capture_records_the_present_flag_and_skips_missing_parents() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let collection_uid = "c".repeat(32);
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO collections (name, sync_uid) VALUES ('Shelf', ?1) RETURNING id",
    )
    .bind(&collection_uid)
    .fetch_one(&pool)
    .await
    .unwrap();
    // The collection insert queued its own marker; start from a clean slate.
    sqlx::query("DELETE FROM sync_dirty")
        .execute(&pool)
        .await
        .unwrap();

    insert_dirty(
        &pool,
        "membership",
        &format!("{book_uid}:{id}"),
        "upsert",
        None,
        Some(&format!(
            r#"{{"book_uid":"{book_uid}","collection_id":{id},"present":true,"added_at":"2026-01-01T00:00:00.000Z"}}"#
        )),
    )
    .await;
    let root = store::resolve_root(tmp.path()).unwrap();
    let covers = tmp.path().join("covers");
    assert_eq!(drain(&pool, &root, &covers, 10).await.unwrap().written, 1);
    let entity_uid = format!("{collection_uid}:{book_uid}");
    let (state, _) = crate::sync::merge::load_state(&pool, EntityKind::Membership, &entity_uid)
        .await
        .unwrap();
    assert_eq!(state.get("present"), Some(&Value::Bool(true)));

    // Removing the book from the shelf carries present=false.
    insert_dirty(
        &pool,
        "membership",
        &format!("{book_uid}:{id}"),
        "delete",
        Some(&format!(
            r#"{{"book_uid":"{book_uid}","collection_id":{id},"present":false}}"#
        )),
        None,
    )
    .await;
    assert_eq!(drain(&pool, &root, &covers, 10).await.unwrap().written, 1);
    let (state, _) = crate::sync::merge::load_state(&pool, EntityKind::Membership, &entity_uid)
        .await
        .unwrap();
    assert_eq!(state.get("present"), Some(&Value::Bool(false)));

    // A book that never became durable, and a collection that is gone.
    insert_dirty(
        &pool,
        "membership",
        "gone:1",
        "upsert",
        None,
        Some(r#"{"book_uid":"dddddddddddddddddddddddddddddddd","collection_id":1,"present":true}"#),
    )
    .await;
    insert_dirty(
        &pool,
        "membership",
        "nope",
        "upsert",
        None,
        Some(&format!(
            r#"{{"book_uid":"{book_uid}","collection_id":999,"present":true}}"#
        )),
    )
    .await;
    assert_eq!(drain(&pool, &root, &covers, 10).await.unwrap().written, 0);
    assert_eq!(dirty_count(&pool).await, 0);
}

/// `Captured::PendingIdentity` has no producer: the membership path calls
/// `resolve_local_uid` with `deleted = false`, and that helper only returns
/// `None` for a deleted marker. An unbound collection is not pending; it
/// gets a uid here, so the capture pass writes the membership instead of
/// counting it as waiting.
#[tokio::test]
async fn an_unbound_collection_membership_mints_a_uid_and_does_not_wait() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = pool_in(tmp.path()).await;
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let collection_id: i64 =
        sqlx::query_scalar("INSERT INTO collections (name) VALUES ('Shelf') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
    // The collection insert queued its own marker; keep only the membership.
    sqlx::query("DELETE FROM sync_dirty")
        .execute(&pool)
        .await
        .unwrap();
    insert_dirty(
        &pool,
        "membership",
        &format!("{book_uid}:{collection_id}"),
        "upsert",
        None,
        Some(&format!(
            r#"{{"book_uid":"{book_uid}","collection_id":{collection_id},"present":true}}"#
        )),
    )
    .await;

    let root = store::resolve_root(tmp.path()).unwrap();
    let report = drain(&pool, &root, &tmp.path().join("covers"), 10)
        .await
        .unwrap();
    assert_eq!(
        report.pending_identity, 0,
        "an unbound collection is resolved, never left pending"
    );
    assert_eq!(report.written, 1);
    let collection_uid: String =
        sqlx::query_scalar("SELECT sync_uid FROM collections WHERE id = ?1")
            .bind(collection_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(collection_uid.len(), 32);
    let (state, deleted) = crate::sync::merge::load_state(
        &pool,
        EntityKind::Membership,
        &format!("{collection_uid}:{book_uid}"),
    )
    .await
    .unwrap();
    assert!(!deleted);
    assert_eq!(state.get("present"), Some(&Value::Bool(true)));
}
