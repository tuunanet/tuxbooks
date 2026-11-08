//! Identity tests, split along the production modules.

use std::time::UNIX_EPOCH;

use sqlx::SqlitePool;

use super::*;
use crate::domain::NewBook;
use crate::repository::books;

mod bind;
mod collection;
mod merge;

fn snapshot(path: &std::path::Path) -> (i64, i64) {
    let metadata = std::fs::metadata(path).unwrap();
    let mtime = metadata
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    (metadata.len() as i64, mtime)
}

async fn book_with_file(pool: &SqlitePool, path: &std::path::Path) -> i64 {
    let (file_size, file_mtime) = snapshot(path);
    books::upsert_book(
        pool,
        &NewBook {
            path: path.to_string_lossy().into_owned(),
            title: "Identity test".into(),
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
            file_size,
            file_mtime,
        },
    )
    .await
    .unwrap()
    .0
}

async fn two_durable_books(pool: &SqlitePool, dir: &std::path::Path) -> (String, String) {
    for (name, bytes) in [
        ("one.epub", b"first bytes".as_slice()),
        ("two.epub", b"second bytes".as_slice()),
    ] {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        books::upsert_book(
            pool,
            &NewBook {
                path: path.to_string_lossy().into_owned(),
                title: name.into(),
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
                file_size: bytes.len() as i64,
                file_mtime: 0,
            },
        )
        .await
        .unwrap();
    }
    let rows: Vec<(String, i64)> = sqlx::query_as("SELECT uid, id FROM book_records ORDER BY id")
        .fetch_all(pool)
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    (rows[0].0.clone(), rows[1].0.clone())
}

async fn state_row(pool: &SqlitePool, kind: &str, uid: &str, book_uid: &str, wall: i64) {
    sqlx::query(
        "INSERT INTO sync_state_entities
            (kind, entity_uid, book_uid, hlc_wall, hlc_counter, hlc_device)
         VALUES (?1, ?2, ?3, ?4, 0, 'other')",
    )
    .bind(kind)
    .bind(uid)
    .bind(book_uid)
    .bind(wall)
    .execute(pool)
    .await
    .unwrap();
}

async fn state_field(
    pool: &SqlitePool,
    kind: &str,
    uid: &str,
    field: &str,
    value: &str,
    wall: i64,
) {
    sqlx::query(
        "INSERT INTO sync_state_fields
            (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 'other')",
    )
    .bind(kind)
    .bind(uid)
    .bind(field)
    .bind(value)
    .bind(wall)
    .execute(pool)
    .await
    .unwrap();
}
