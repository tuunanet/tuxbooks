//! Fixtures shared by the merge tests: a real database per test, seeded with
//! books, mirror state, and trash rows.

use serde_json::Value;
use sqlx::SqlitePool;

use crate::sync::model::{EntityKind, Hlc, Op, OP_SCHEMA};

pub(super) fn op(kind: EntityKind, uid: &str, book: &str, fields: Value) -> Op {
    Op {
        schema: OP_SCHEMA,
        op_id: format!("{:032x}", rand_id()),
        device_id: "b".repeat(32),
        hlc: Hlc {
            wall: 100,
            counter: 0,
            device: "b".repeat(32),
        },
        kind,
        entity_uid: uid.into(),
        book_uid: Some(book.into()),
        deleted: false,
        restore: false,
        fields: fields.as_object().unwrap().clone(),
        prior: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

pub(super) fn rand_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub(super) async fn forget_book(pool: &SqlitePool, uid: &str, replacement: Option<&str>) {
    sqlx::query(
        "INSERT INTO sync_book_trash
            (book_uid, replacement_book_uid, snapshot_json, deleted_wall,
             deleted_count, deleted_dev, deleted_at, expires_at)
         VALUES (?1, ?2, NULL, 50, 0, 'other', '2026-01-01T00:00:00.000Z',
                 '2999-01-01T00:00:00.000Z')",
    )
    .bind(uid)
    .bind(replacement)
    .execute(pool)
    .await
    .unwrap();
}

pub(super) async fn durable_book(pool: &SqlitePool, path: &std::path::Path) -> (String, i64) {
    std::fs::write(path, b"merge test bytes").unwrap();
    crate::repository::books::upsert_book(
        pool,
        &crate::domain::NewBook {
            path: path.to_string_lossy().into_owned(),
            title: "Merge test".into(),
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
            file_size: 15,
            file_mtime: 0,
        },
    )
    .await
    .unwrap();
    sqlx::query_as("SELECT uid, id FROM book_records LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap()
}

pub(super) async fn put_state(
    pool: &SqlitePool,
    kind: EntityKind,
    uid: &str,
    fields: &[(&str, Value)],
) {
    sqlx::query(
        "INSERT INTO sync_state_entities (kind, entity_uid) VALUES (?1, ?2)
         ON CONFLICT(kind, entity_uid) DO NOTHING",
    )
    .bind(kind.as_str())
    .bind(uid)
    .execute(pool)
    .await
    .unwrap();
    for (field, value) in fields {
        sqlx::query(
            "INSERT INTO sync_state_fields
                (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
             VALUES (?1, ?2, ?3, ?4, 1, 0, 'other')
             ON CONFLICT(kind, entity_uid, field) DO UPDATE SET
                value_json = excluded.value_json",
        )
        .bind(kind.as_str())
        .bind(uid)
        .bind(field)
        .bind(serde_json::to_string(value).unwrap())
        .execute(pool)
        .await
        .unwrap();
    }
}

pub(super) async fn create_book(pool: &SqlitePool) -> String {
    let book_id = crate::repository::books::upsert_book(
        pool,
        &crate::domain::NewBook {
            path: "/tmp/sync-test.epub".into(),
            title: "Sync test".into(),
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
    .unwrap()
    .0;
    let uid = "f".repeat(32);
    sqlx::query(
        "INSERT INTO sync_book_bindings (book_id, book_uid, content_hash, hashed_size, hashed_mtime)
         VALUES (?1, ?2, 'x', 0, 0)",
    )
    .bind(book_id)
    .bind(&uid)
    .execute(pool)
    .await
    .unwrap();
    uid
}
