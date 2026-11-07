//! Projection: how the mirror becomes local collections, memberships,
//! annotations, progress, and last-opened rows.

use serde_json::json;

use super::support::{durable_book, put_state};
use crate::sync::merge::{project, Affected};
use crate::sync::model::EntityKind;

#[tokio::test]
async fn project_creates_updates_and_deletes_collections_by_uid_or_name() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let covers = tmp.path().join("covers");
    let dir = tempfile::tempdir().unwrap();

    let uid = "c2".repeat(16);
    put_state(
        &pool,
        EntityKind::Collection,
        &uid,
        &[
            ("name", json!("Shelf")),
            ("created_at", json!("2026-01-01T00:00:00.000Z")),
        ],
    )
    .await;
    let affected = |uid: &str| {
        vec![Affected {
            kind: EntityKind::Collection,
            entity_uid: uid.into(),
            book_uid: None,
        }]
    };
    assert!(project(&pool, dir.path(), &covers, &affected(&uid))
        .await
        .unwrap()
        .is_empty());
    let (id, name): (i64, String) =
        sqlx::query_as("SELECT id, name FROM collections WHERE sync_uid = ?1")
            .bind(&uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(name, "Shelf");

    put_state(
        &pool,
        EntityKind::Collection,
        &uid,
        &[("name", json!("Renamed"))],
    )
    .await;
    project(&pool, dir.path(), &covers, &affected(&uid))
        .await
        .unwrap();
    let name: String = sqlx::query_scalar("SELECT name FROM collections WHERE id = ?1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(name, "Renamed");

    // A local shelf with no portable uid adopts the first uid it sees.
    let unnamed: i64 =
        sqlx::query_scalar("INSERT INTO collections (name) VALUES ('Local only') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
    let taken = "c3".repeat(16);
    put_state(
        &pool,
        EntityKind::Collection,
        &taken,
        &[("name", json!("Local only"))],
    )
    .await;
    project(&pool, dir.path(), &covers, &affected(&taken))
        .await
        .unwrap();
    let sync_uid: String = sqlx::query_scalar("SELECT sync_uid FROM collections WHERE id = ?1")
        .bind(unnamed)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sync_uid, taken);

    // Two portable ids for one name converge on the smaller one.
    let local = "f".repeat(32);
    let remote = "d4".repeat(16);
    sqlx::query("INSERT INTO collections (name, sync_uid) VALUES ('Shared', ?1)")
        .bind(&local)
        .execute(&pool)
        .await
        .unwrap();
    put_state(
        &pool,
        EntityKind::Collection,
        &remote,
        &[("name", json!("Shared"))],
    )
    .await;
    project(&pool, dir.path(), &covers, &affected(&remote))
        .await
        .unwrap();
    let winner: String =
        sqlx::query_scalar("SELECT sync_uid FROM collections WHERE name = 'Shared'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(winner, remote, "the lexicographically smaller uid survives");

    // A state with no name is ignored, and a tombstone removes the shelf.
    let nameless = "e5".repeat(16);
    put_state(&pool, EntityKind::Collection, &nameless, &[]).await;
    project(&pool, dir.path(), &covers, &affected(&nameless))
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collections WHERE sync_uid = ?1")
        .bind(&nameless)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);

    sqlx::query("UPDATE sync_state_entities SET deleted = 1 WHERE kind = 'collection' AND entity_uid = ?1")
        .bind(&taken)
        .execute(&pool)
        .await
        .unwrap();
    project(&pool, dir.path(), &covers, &affected(&taken))
        .await
        .unwrap();
    let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collections WHERE id = ?1")
        .bind(unnamed)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(gone, 0);
}

#[tokio::test]
async fn project_adds_and_removes_memberships_and_skips_missing_parents() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let collection_uid = "d6".repeat(16);
    let collection_id: i64 = sqlx::query_scalar(
        "INSERT INTO collections (name, sync_uid) VALUES ('Shelf', ?1) RETURNING id",
    )
    .bind(&collection_uid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let entity_uid = format!("{collection_uid}:{book_uid}");
    put_state(
        &pool,
        EntityKind::Membership,
        &entity_uid,
        &[("present", json!(true))],
    )
    .await;
    let item = |uid: &str, book: Option<&str>| {
        vec![Affected {
            kind: EntityKind::Membership,
            entity_uid: uid.into(),
            book_uid: book.map(str::to_string),
        }]
    };
    let covers = tmp.path().join("covers");
    project(
        &pool,
        tmp.path(),
        &covers,
        &item(&entity_uid, Some(&book_uid)),
    )
    .await
    .unwrap();
    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM book_collections WHERE book_uid = ?1 AND collection_id = ?2",
    )
    .bind(&book_uid)
    .bind(collection_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(members, 1);

    put_state(
        &pool,
        EntityKind::Membership,
        &entity_uid,
        &[("present", json!(false))],
    )
    .await;
    project(
        &pool,
        tmp.path(),
        &covers,
        &item(&entity_uid, Some(&book_uid)),
    )
    .await
    .unwrap();
    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM book_collections WHERE book_uid = ?1 AND collection_id = ?2",
    )
    .bind(&book_uid)
    .bind(collection_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(members, 0);

    // Unknown book, unknown collection, and a uid with no colon are inert.
    let unknown_book = "d7".repeat(16);
    let unknown_entity = format!("{collection_uid}:{unknown_book}");
    put_state(
        &pool,
        EntityKind::Membership,
        &unknown_entity,
        &[("present", json!(true))],
    )
    .await;
    project(
        &pool,
        tmp.path(),
        &covers,
        &item(&unknown_entity, Some(&unknown_book)),
    )
    .await
    .unwrap();
    let unknown_collection = format!("{}:{book_uid}", "d8".repeat(16));
    put_state(
        &pool,
        EntityKind::Membership,
        &unknown_collection,
        &[("present", json!(true))],
    )
    .await;
    project(
        &pool,
        tmp.path(),
        &covers,
        &item(&unknown_collection, Some(&book_uid)),
    )
    .await
    .unwrap();
    project(&pool, tmp.path(), &covers, &item("no-colon", Some(&book_uid)))
        .await
        .unwrap();
    let members: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_collections")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(members, 0);
}

#[tokio::test]
async fn project_removes_deleted_annotations_progress_and_updates_opened() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let (book_uid, _) = durable_book(&pool, &tmp.path().join("book.epub")).await;
    let annotation_uid = "d9".repeat(16);
    sqlx::query(
        "INSERT INTO annotations (book_uid, sync_uid, kind, cfi) VALUES (?1, ?2, 'bookmark', 'x')",
    )
    .bind(&book_uid)
    .bind(&annotation_uid)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO reading_progress (book_uid, progress_percent) VALUES (?1, 10.0)")
        .bind(&book_uid)
        .execute(&pool)
        .await
        .unwrap();
    put_state(&pool, EntityKind::Annotation, &annotation_uid, &[]).await;
    put_state(&pool, EntityKind::Progress, &book_uid, &[]).await;
    sqlx::query(
        "UPDATE sync_state_entities SET deleted = 1 WHERE
            (kind = 'annotation' AND entity_uid = ?1)
         OR (kind = 'progress' AND entity_uid = ?2)",
    )
    .bind(&annotation_uid)
    .bind(&book_uid)
    .execute(&pool)
    .await
    .unwrap();
    let covers = tmp.path().join("covers");
    let affected = vec![
        Affected {
            kind: EntityKind::Annotation,
            entity_uid: annotation_uid.clone(),
            book_uid: Some(book_uid.clone()),
        },
        Affected {
            kind: EntityKind::Progress,
            entity_uid: book_uid.clone(),
            book_uid: Some(book_uid.clone()),
        },
    ];
    let books = project(&pool, tmp.path(), &covers, &affected)
        .await
        .unwrap();
    assert_eq!(books, vec![1]);
    let annotations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM annotations WHERE sync_uid = ?1")
            .bind(&annotation_uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(annotations, 0);
    let progress: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM reading_progress WHERE book_uid = ?1")
            .bind(&book_uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(progress, 0);

    // The last-opened stamp projects straight into the durable record.
    put_state(
        &pool,
        EntityKind::Opened,
        &book_uid,
        &[("last_opened_at", json!("2026-02-03T04:05:06.000Z"))],
    )
    .await;
    project(
        &pool,
        tmp.path(),
        &covers,
        &[Affected {
            kind: EntityKind::Opened,
            entity_uid: book_uid.clone(),
            book_uid: Some(book_uid.clone()),
        }],
    )
    .await
    .unwrap();
    let opened: Option<String> =
        sqlx::query_scalar("SELECT last_opened_at FROM book_records WHERE uid = ?1")
            .bind(&book_uid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(opened.as_deref(), Some("2026-02-03T04:05:06.000Z"));
}

#[tokio::test]
async fn project_skips_identity_ops_and_books_without_a_durable_record() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();
    let covers = tmp.path().join("covers");
    let affected = vec![
        Affected {
            kind: EntityKind::BookIdentity,
            entity_uid: "e1".repeat(16),
            book_uid: None,
        },
        Affected {
            kind: EntityKind::Annotation,
            entity_uid: "e2".repeat(16),
            book_uid: Some("e3".repeat(16)),
        },
        Affected {
            kind: EntityKind::Collection,
            entity_uid: "e4".repeat(16),
            book_uid: None,
        },
    ];
    assert!(project(&pool, tmp.path(), &covers, &affected)
        .await
        .unwrap()
        .is_empty());
}
