//! Projection edge cases: lifecycle failures, metadata covers, and affected
//! entries that have nothing local to project into.

use serde_json::{json, Value};

use super::support::{durable_book, forget_book, put_state};
use crate::sync::merge::{project, project_book, Affected};
use crate::sync::model::EntityKind;

#[tokio::test]
async fn a_corrupt_shared_snapshot_becomes_a_lifecycle_issue() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let uid = "fc".repeat(16);
    sqlx::query(
        "INSERT INTO sync_book_trash
            (book_uid, replacement_book_uid, snapshot_json, deleted_wall,
             deleted_count, deleted_dev, deleted_at, expires_at, restored_at,
             discarded, restored_wall, restored_count, restored_dev)
         VALUES (?1, NULL, '{not json', 10, 0, 'other',
                 '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z',
                 '2026-01-02T00:00:00.000Z', 0, 20, 0, 'other')",
    )
    .bind(&uid)
    .execute(&pool)
    .await
    .unwrap();
    let covers = tmp.path().join("covers");
    assert!(project(
        &pool,
        tmp.path(),
        &covers,
        &[Affected {
            kind: EntityKind::Book,
            entity_uid: uid.clone(),
            book_uid: Some(uid.clone()),
        }],
    )
    .await
    .unwrap()
    .is_empty());
    let issue: String =
        sqlx::query_scalar("SELECT detail FROM sync_issues WHERE kind = 'book_lifecycle_failed'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(issue.contains(&uid), "{issue}");
}

#[tokio::test]
async fn metadata_projection_without_a_cover_blob_still_applies() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let covers = tmp.path().join("covers");

    put_state(
        &pool,
        EntityKind::Metadata,
        &book_uid,
        &[
            ("title", json!("Missing cover")),
            ("cover_path", json!("0123456789abcdef.png")),
        ],
    )
    .await;
    project(
        &pool,
        tmp.path(),
        &covers,
        &[Affected {
            kind: EntityKind::Metadata,
            entity_uid: book_uid.clone(),
            book_uid: Some(book_uid.clone()),
        }],
    )
    .await
    .unwrap();
    let (title, cover): (String, Option<String>) =
        sqlx::query_as("SELECT title, cover_path FROM book_records WHERE uid = ?1")
            .bind(&book_uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(title, "Missing cover");
    assert!(cover.is_none(), "the missing blob is not invented");

    put_state(
        &pool,
        EntityKind::Metadata,
        &book_uid,
        &[
            ("title", json!("No cover field")),
            ("cover_path", Value::Null),
        ],
    )
    .await;
    project(
        &pool,
        tmp.path(),
        &covers,
        &[Affected {
            kind: EntityKind::Metadata,
            entity_uid: book_uid.clone(),
            book_uid: Some(book_uid.clone()),
        }],
    )
    .await
    .unwrap();
    let (title, cover): (String, Option<String>) =
        sqlx::query_as("SELECT title, cover_path FROM book_records WHERE uid = ?1")
            .bind(&book_uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(title, "No cover field");
    assert!(cover.is_none(), "a null cover clears the stored path");
}

#[tokio::test]
async fn collection_projection_skips_memberships_for_unknown_or_deleted_books() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let covers = tmp.path().join("covers");
    let collection_uid = "fd".repeat(16);
    put_state(
        &pool,
        EntityKind::Collection,
        &collection_uid,
        &[("name", json!("Shelf"))],
    )
    .await;
    let unknown_book = "fe".repeat(16);
    let unknown_entity = format!("{collection_uid}:{unknown_book}");
    put_state(
        &pool,
        EntityKind::Membership,
        &unknown_entity,
        &[("present", json!(true))],
    )
    .await;
    let deleted_book = "ff".repeat(16);
    let deleted_entity = format!("{collection_uid}:{deleted_book}");
    put_state(
        &pool,
        EntityKind::Membership,
        &deleted_entity,
        &[("present", json!(true))],
    )
    .await;
    sqlx::query("UPDATE sync_state_entities SET deleted = 1 WHERE entity_uid = ?1")
        .bind(&deleted_entity)
        .execute(&pool)
        .await
        .unwrap();

    project(
        &pool,
        tmp.path(),
        &covers,
        &[Affected {
            kind: EntityKind::Collection,
            entity_uid: collection_uid,
            book_uid: None,
        }],
    )
    .await
    .unwrap();
    let members: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_collections")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(members, 0, "neither membership can be projected");
}

#[tokio::test]
async fn project_book_returns_nothing_for_a_forgotten_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let uid = "e5".repeat(16);
    forget_book(&pool, &uid, None).await;
    let covers = tmp.path().join("covers");
    assert!(project_book(&pool, &uid, tmp.path(), &covers)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn project_skips_a_missing_book_uid_and_a_book_without_a_trash_row() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let covers = tmp.path().join("covers");
    let affected = vec![
        Affected {
            kind: EntityKind::Annotation,
            entity_uid: "fa".repeat(16),
            book_uid: None,
        },
        Affected {
            kind: EntityKind::Book,
            entity_uid: "fb".repeat(16),
            book_uid: None,
        },
    ];
    assert!(project(&pool, tmp.path(), &covers, &affected)
        .await
        .unwrap()
        .is_empty());
}
