
use super::*;
use sqlx::SqlitePool;

use crate::domain::{Book, NewBook};
use crate::error::AppError;

fn sample(path: &str, title: &str) -> NewBook {
    NewBook {
        path: path.into(),
        title: title.into(),
        subtitle: Some("A Subtitle".into()),
        author: Some("Author".into()),
        authors: vec!["Author".into()],
        subjects: Vec::new(),
        publisher: None,
        language: Some("en".into()),
        isbn: None,
        description: None,
        cover_path: None,
        publication_date: None,
        series: None,
        series_index: None,
        file_size: 100,
        file_mtime: 1_700_000_000,
    }
}

#[tokio::test]
async fn insert_and_roundtrip() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    let id = insert_book(&pool, &sample("/a.epub", "Alpha"))
        .await
        .unwrap();
    let book = get_book(&pool, id).await.unwrap().unwrap();
    assert_eq!(book.title, "Alpha");
    assert_eq!(book.subtitle.as_deref(), Some("A Subtitle"));
    assert_eq!(book.path, "/a.epub");
    assert_eq!(book.id, id);
    assert!(book.file_id.is_some());
}

#[tokio::test]
async fn duplicate_path_violates_unique_constraint() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    insert_book(&pool, &sample("/a.epub", "Alpha"))
        .await
        .unwrap();
    let err = insert_book(&pool, &sample("/a.epub", "Again"))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Database(_)), "got: {err:?}");
}

#[tokio::test]
async fn upsert_inserts_then_updates() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    let (id1, inserted) = upsert_book(&pool, &sample("/a.epub", "Alpha"))
        .await
        .unwrap();
    assert!(inserted);

    let (id2, inserted) = upsert_book(&pool, &sample("/a.epub", "Alpha v2"))
        .await
        .unwrap();
    assert!(!inserted);
    assert_eq!(id1, id2);

    let book = get_book(&pool, id1).await.unwrap().unwrap();
    assert_eq!(book.title, "Alpha v2");
    assert_eq!(count_books(&pool).await.unwrap(), 1);
}

#[tokio::test]
async fn empty_title_is_rejected_by_check_constraint() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    let err = insert_book(&pool, &sample("/a.epub", "   "))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Database(_)), "got: {err:?}");
}

#[tokio::test]
async fn removing_the_last_file_keeps_reading_progress() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    let id = insert_book(&pool, &sample("/a.epub", "Alpha"))
        .await
        .unwrap();
    crate::repository::reading_progress::upsert_progress(
        &pool,
        id,
        &crate::domain::ProgressUpdate {
            chapter_href: Some("c1.xhtml".into()),
            cfi: None,
            character_offset: Some(120),
            page_number: None,
            scroll_offset: None,
            progress_percent: Some(12.5),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert!(delete_book(&pool, id).await.unwrap());

    let progress = crate::repository::reading_progress::get_progress(&pool, id)
        .await
        .unwrap();
    let progress = progress.expect("reading progress must survive the last file");
    assert_eq!(progress.progress_percent, Some(12.5));
    assert!(get_book(&pool, id).await.unwrap().is_none());
}

#[tokio::test]
async fn list_books_orders_by_title_case_insensitive() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    upsert_book(&pool, &sample("/b.epub", "beta"))
        .await
        .unwrap();
    upsert_book(&pool, &sample("/a.epub", "Alpha"))
        .await
        .unwrap();
    upsert_book(&pool, &sample("/c.epub", "Charlie"))
        .await
        .unwrap();

    let titles: Vec<String> = list_books(&pool)
        .await
        .unwrap()
        .into_iter()
        .map(|b| b.title)
        .collect();
    assert_eq!(titles, vec!["Alpha", "beta", "Charlie"]);
}

/// The retired flag must not appear in any read's serialization.
fn assert_no_loose_flag(book: &Book) {
    let json = serde_json::to_value(book).unwrap();
    assert!(
        json.get("loose").is_none(),
        "the loose flag must not appear in a book payload: {json}"
    );
    assert!(
        json.get("fileId").is_none(),
        "the internal file row must never cross the IPC boundary: {json}"
    );
}

#[tokio::test]
async fn book_reads_carry_no_loose_field() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    crate::repository::library_locations::add_location(&pool, "/lib")
        .await
        .unwrap();
    let (inside_id, _) = upsert_book(&pool, &sample("/lib/inside.epub", "Inside"))
        .await
        .unwrap();
    let (sibling_id, _) = upsert_book(&pool, &sample("/libx/sibling.epub", "Sibling"))
        .await
        .unwrap();
    let (outside_id, _) = upsert_book(&pool, &sample("/outside.epub", "Outside"))
        .await
        .unwrap();

    // All three reads share the struct, so none may expose a loose flag.
    let books = list_books(&pool).await.unwrap();
    for book in &books {
        assert_no_loose_flag(book);
    }
    let titles: Vec<&str> = books.iter().map(|book| book.title.as_str()).collect();
    assert_eq!(titles, vec!["Inside", "Outside", "Sibling"]);

    for id in [inside_id, sibling_id, outside_id] {
        assert_no_loose_flag(&get_book(&pool, id).await.unwrap().unwrap());
    }
    assert_no_loose_flag(
        &get_book_by_path(&pool, "/outside.epub")
            .await
            .unwrap()
            .unwrap(),
    );
}

#[tokio::test]
async fn inserted_books_start_available_with_file_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    let id = insert_book(&pool, &sample("/a.epub", "Alpha"))
        .await
        .unwrap();
    let book = get_book(&pool, id).await.unwrap().unwrap();
    assert!(book.available);
    assert_eq!(book.file_size, 100);
    assert_eq!(book.file_mtime, 1_700_000_000);
}

#[tokio::test]
async fn set_availability_prefix_hits_exact_and_children_only() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    upsert_book(&pool, &sample("/lib/a.epub", "A"))
        .await
        .unwrap();
    upsert_book(&pool, &sample("/lib/b.epub", "B"))
        .await
        .unwrap();
    upsert_book(&pool, &sample("/libx/c.epub", "C"))
        .await
        .unwrap();
    upsert_book(&pool, &sample("/lib_sub/under_score.epub", "D"))
        .await
        .unwrap();

    // A bare prefix must not match `/libx`, and literal `_` is not a wildcard.
    let affected = set_availability_prefix(&pool, "/lib", false).await.unwrap();
    let mut paths: Vec<String> = affected.iter().map(|b| b.path.clone()).collect();
    paths.sort();
    assert_eq!(paths, vec!["/lib/a.epub", "/lib/b.epub"]);
    assert!(affected.iter().all(|b| !b.available));

    assert_eq!(
        stayed_available_sorted(&pool).await,
        vec!["/lib_sub/under_score.epub", "/libx/c.epub"]
    );

    let again = set_availability_prefix(&pool, "/lib", false).await.unwrap();
    assert!(again.is_empty());

    let restored = set_availability_prefix(&pool, "/lib", true).await.unwrap();
    assert_eq!(restored.len(), 2);
    assert!(restored.iter().all(|b| b.available));
}

async fn stayed_available_sorted(pool: &SqlitePool) -> Vec<String> {
    let mut paths: Vec<String> = list_books(pool)
        .await
        .unwrap()
        .into_iter()
        .filter(|b| b.available)
        .map(|b| b.path)
        .collect();
    paths.sort();
    paths
}

#[tokio::test]
async fn relink_updates_path_and_keeps_progress() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    let id = insert_book(&pool, &sample("/old/a.epub", "Alpha"))
        .await
        .unwrap();
    let file_id = active_file_id(&pool, id).await.unwrap().unwrap();
    crate::repository::reading_progress::upsert_progress(
        &pool,
        id,
        &crate::domain::ProgressUpdate {
            chapter_href: Some("c1.xhtml".into()),
            cfi: None,
            character_offset: Some(42),
            page_number: None,
            scroll_offset: None,
            progress_percent: Some(40.0),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let outcome = relink_book(&pool, file_id, "/new/renamed.epub", 200, 1_800_000_000)
        .await
        .unwrap();
    assert_eq!(outcome, RelinkOutcome::Relinked);

    let book = get_book(&pool, id).await.unwrap().unwrap();
    assert_eq!(book.path, "/new/renamed.epub");
    assert!(book.available);
    assert_eq!(book.file_size, 200);
    assert_eq!(book.file_mtime, 1_800_000_000);

    let progress = crate::repository::reading_progress::get_progress(&pool, id)
        .await
        .unwrap();
    assert!(progress.is_some(), "relink must preserve reading progress");
}

#[tokio::test]
async fn relink_conflicts_with_existing_path() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    let id = insert_book(&pool, &sample("/a.epub", "Alpha"))
        .await
        .unwrap();
    let file_id = active_file_id(&pool, id).await.unwrap().unwrap();
    insert_book(&pool, &sample("/b.epub", "Beta"))
        .await
        .unwrap();

    let outcome = relink_book(&pool, file_id, "/b.epub", 200, 1_800_000_000)
        .await
        .unwrap();
    assert_eq!(outcome, RelinkOutcome::PathConflict);
    let book = get_book(&pool, id).await.unwrap().unwrap();
    assert_eq!(book.path, "/a.epub");
    assert_eq!(count_books(&pool).await.unwrap(), 2);
}

#[tokio::test]
async fn list_books_in_prefix_matches_scope() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::connection::init_pool(&tmp.path().join("t.db"))
        .await
        .unwrap();

    upsert_book(&pool, &sample("/lib/a.epub", "A"))
        .await
        .unwrap();
    upsert_book(&pool, &sample("/lib/sub/b.epub", "B"))
        .await
        .unwrap();
    upsert_book(&pool, &sample("/elsewhere/c.epub", "C"))
        .await
        .unwrap();

    let mut paths: Vec<String> = list_books_in_prefix(&pool, "/lib")
        .await
        .unwrap()
        .into_iter()
        .map(|b| b.path)
        .collect();
    paths.sort();
    assert_eq!(paths, vec!["/lib/a.epub", "/lib/sub/b.epub"]);
}
