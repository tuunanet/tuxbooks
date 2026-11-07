//! Shared capture-test harness: pools, durable books, and dirty rows.

use sqlx::SqlitePool;

pub(super) async fn pool_in(dir: &std::path::Path) -> SqlitePool {
    crate::db::connection::init_pool(&dir.join("t.db"))
        .await
        .unwrap()
}

/// A hashed-able book row plus its durable record (uid, record id).
pub(super) async fn durable_book(pool: &SqlitePool, path: &std::path::Path) -> (String, i64) {
    std::fs::write(path, b"capture test bytes").unwrap();
    crate::repository::books::upsert_book(
        pool,
        &crate::domain::NewBook {
            path: path.to_string_lossy().into_owned(),
            title: "Capture test".into(),
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
            file_size: 18,
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

pub(super) async fn insert_dirty(
    pool: &SqlitePool,
    kind: &str,
    key: &str,
    op: &str,
    old: Option<&str>,
    new: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(kind)
    .bind(key)
    .bind(op)
    .bind(old)
    .bind(new)
    .execute(pool)
    .await
    .unwrap();
}

pub(super) async fn dirty_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_dirty")
        .fetch_one(pool)
        .await
        .unwrap()
}

pub(super) async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sync_ops")
        .fetch_one(pool)
        .await
        .unwrap()
}
