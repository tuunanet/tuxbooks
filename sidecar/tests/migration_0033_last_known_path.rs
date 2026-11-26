//! Migration 0033 last-known-path default (ADR 0014 D5, tuxbooks-t9p.1).
//! Split from `durable_books.rs` to keep each test crate under the file limit.

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tuxbooks_lib::db::connection::init_pool_recovering;
use tuxbooks_lib::domain::NewBook;
use tuxbooks_lib::repository::books;

/// A copy of the migration set up to and including `max_version`, so a test
/// can create the schema an earlier release shipped.
async fn migrator_through(dir: &Path, max_version: u64) -> sqlx::migrate::Migrator {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let target = dir.join(format!("migrations-{max_version}"));
    std::fs::create_dir_all(&target).unwrap();
    for entry in std::fs::read_dir(&source).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(version) = name
            .strip_prefix('0')
            .and_then(|rest| rest.split('_').next())
            .and_then(|digits| digits.parse::<u64>().ok())
        else {
            continue;
        };
        if version <= max_version {
            std::fs::copy(entry.path(), target.join(&name)).unwrap();
        }
    }
    sqlx::migrate::Migrator::new(target).await.unwrap()
}

#[tokio::test]
async fn migration_0033_adds_last_known_path_with_an_empty_default() {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("tuxbooks.db");
    let fixture = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    migrator_through(tmp.path(), 32)
        .await
        .run(&fixture)
        .await
        .unwrap();

    books::upsert_book(
        &fixture,
        &NewBook {
            path: "/library/old.epub".into(),
            title: "Old".into(),
            subtitle: None,
            author: None,
            authors: Vec::new(),
            subjects: Vec::new(),
            publisher: None,
            language: None,
            isbn: None,
            description: None,
            cover_path: None,
            publication_date: None,
            series: None,
            series_index: None,
            file_size: 1,
            file_mtime: 1,
        },
    )
    .await
    .unwrap();
    sqlx::query("DELETE FROM books WHERE path = '/library/old.epub'")
        .execute(&fixture)
        .await
        .unwrap();
    fixture.close().await;

    let (pool, recovery) = init_pool_recovering(&db_path).await.unwrap();
    assert!(recovery.is_none());

    let history = books::list_reading_history(&pool, None).await.unwrap();
    assert_eq!(history.len(), 1, "the detached record survives the upgrade");
    assert!(
        history[0].last_known_path.is_none(),
        "records detached before the change have no path"
    );

    books::upsert_book(
        &pool,
        &NewBook {
            path: "/library/new.epub".into(),
            title: "New".into(),
            subtitle: None,
            author: None,
            authors: Vec::new(),
            subjects: Vec::new(),
            publisher: None,
            language: None,
            isbn: None,
            description: None,
            cover_path: None,
            publication_date: None,
            series: None,
            series_index: None,
            file_size: 1,
            file_mtime: 1,
        },
    )
    .await
    .unwrap();
    let book = books::get_book_by_path(&pool, "/library/new.epub")
        .await
        .unwrap()
        .expect("imported book");
    books::delete_book(&pool, book.id).await.unwrap();

    let history = books::list_reading_history(&pool, None).await.unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(
        history
            .iter()
            .find(|row| row.title.as_deref() == Some("New"))
            .and_then(|row| row.last_known_path.as_deref()),
        Some("/library/new.epub")
    );
}
