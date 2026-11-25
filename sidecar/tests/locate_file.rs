//! Locate File resolution: a missing book whose picked file belongs to another
//! entry merges when that is lossless and reports a conflict otherwise.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tempfile::TempDir;
use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::NewBook;
use tuxbooks_lib::repository::{books, editions, reading_history};
use tuxbooks_lib::services::locate_file::{locate_book, LocateOutcome};

fn minimal_epub() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/minimal.epub")
}

struct Env {
    _tmp: TempDir,
    dir: PathBuf,
    covers: PathBuf,
    pool: SqlitePool,
}

async fn setup() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let dir = tmp.path().join("library");
    std::fs::create_dir_all(&dir).unwrap();
    let covers = tmp.path().join("covers");
    Env {
        dir,
        covers,
        pool,
        _tmp: tmp,
    }
}

fn new_book(path: &Path, title: &str, size: i64) -> NewBook {
    NewBook {
        path: path.to_string_lossy().into_owned(),
        title: title.into(),
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
        file_size: size,
        file_mtime: 1,
    }
}

async fn insert(pool: &SqlitePool, path: &Path, title: &str, size: i64) -> i64 {
    books::insert_book(pool, &new_book(path, title, size))
        .await
        .unwrap()
}

async fn uid(pool: &SqlitePool, book_id: i64) -> String {
    books::get_book(pool, book_id)
        .await
        .unwrap()
        .unwrap()
        .book_uid
        .unwrap()
}

async fn file_id(pool: &SqlitePool, book_id: i64) -> i64 {
    books::file_ids_for_book(pool, book_id)
        .await
        .unwrap()
        .first()
        .copied()
        .unwrap()
}

async fn bind(pool: &SqlitePool, book_id: i64, hash: &str) {
    sqlx::query(
        "INSERT INTO sync_book_bindings
             (book_id, book_uid, content_hash, hashed_size, hashed_mtime)
         VALUES (?1, ?2, ?3, 1, 1)",
    )
    .bind(file_id(pool, book_id).await)
    .bind(uid(pool, book_id).await)
    .bind(hash)
    .execute(pool)
    .await
    .unwrap();
}

async fn add_state(pool: &SqlitePool, book_id: i64, progress: f64) {
    let book_uid = uid(pool, book_id).await;
    sqlx::query(
        "INSERT INTO annotations (book_uid, sync_uid, kind, text)
         VALUES (?1, ?2, 'highlight', 'a passage')",
    )
    .bind(&book_uid)
    .bind("a".repeat(32))
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO reading_progress (book_uid, progress_percent)
         VALUES (?1, ?2)",
    )
    .bind(&book_uid)
    .bind(progress)
    .execute(pool)
    .await
    .unwrap();
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[tokio::test(flavor = "multi_thread")]
async fn empty_duplicate_moves_to_reading_history() {
    let env = setup().await;
    let present = env.dir.join("present.epub");
    std::fs::copy(minimal_epub(), &present).unwrap();
    let missing = env.dir.join("missing.epub");
    let size = std::fs::metadata(&present).unwrap().len() as i64;

    let candidate = insert(&env.pool, &missing, "Old copy", size).await;
    let owner = insert(&env.pool, &present, "Machine Learning", size).await;
    sqlx::query("UPDATE books SET available = 0 WHERE id = ?1")
        .bind(file_id(&env.pool, candidate).await)
        .execute(&env.pool)
        .await
        .unwrap();

    let outcome = locate_book(&env.pool, candidate, &present, &env.covers, &[])
        .await
        .unwrap();
    let LocateOutcome::Detached {
        book,
        detached_from,
    } = outcome
    else {
        panic!("expected a detach, got {outcome:?}");
    };
    assert_eq!(book.id, owner);
    assert_eq!(detached_from.id, candidate);
    assert_eq!(detached_from.title, "Old copy");
    let durable: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM book_records WHERE id = ?1")
        .bind(candidate)
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!(
        durable, 1,
        "the empty duplicate keeps its durable record for Reading history"
    );
    assert!(
        books::list_files_for_book(&env.pool, candidate)
            .await
            .unwrap()
            .is_empty(),
        "the missing file row is gone from the library"
    );
    let files = books::list_files_for_book(&env.pool, owner).await.unwrap();
    assert_eq!(files.len(), 1, "the owner keeps only its own location");

    let history = reading_history::list(&env.pool, None).await.unwrap();
    let row = history
        .iter()
        .find(|row| row.id == candidate)
        .expect("the detached duplicate is in Reading history");
    assert!(row.is_empty_duplicate);
    assert_eq!(row.duplicate_of_title.as_deref(), Some("Machine Learning"));

    // Binding a file row makes it a real book again, so the label clears.
    let revived = env.dir.join("revived.epub");
    books::insert_file_for_book(&env.pool, candidate, &new_book(&revived, "Old copy", size))
        .await
        .unwrap();
    let marked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM book_detached_duplicates
         WHERE book_uid = (SELECT uid FROM book_records WHERE id = ?1)",
    )
    .bind(candidate)
    .fetch_one(&env.pool)
    .await
    .unwrap();
    assert_eq!(marked, 0, "the label does not outlive the empty state");
    assert!(
        reading_history::list(&env.pool, None)
            .await
            .unwrap()
            .iter()
            .all(|row| row.id != candidate),
        "a record with a file is no longer in Reading history"
    );
}

/// The Locate duplicate detach remembers where the candidate's file was, so
/// the record can show "Was at <path>" (tuxbooks-t9p.1).
#[tokio::test(flavor = "multi_thread")]
async fn detaching_a_duplicate_remembers_where_its_file_was() {
    let env = setup().await;
    let present = env.dir.join("present.epub");
    std::fs::copy(minimal_epub(), &present).unwrap();
    let missing = env.dir.join("missing.epub");
    let size = std::fs::metadata(&present).unwrap().len() as i64;

    let candidate = insert(&env.pool, &missing, "Old copy", size).await;
    let owner = insert(&env.pool, &present, "Machine Learning", size).await;
    sqlx::query("UPDATE books SET available = 0 WHERE id = ?1")
        .bind(file_id(&env.pool, candidate).await)
        .execute(&env.pool)
        .await
        .unwrap();

    let outcome = locate_book(&env.pool, candidate, &present, &env.covers, &[])
        .await
        .unwrap();
    assert!(
        matches!(outcome, LocateOutcome::Detached { .. }),
        "expected a detach, got {outcome:?}"
    );

    let row = reading_history::list(&env.pool, None)
        .await
        .unwrap()
        .into_iter()
        .find(|row| row.id == candidate)
        .expect("the detached duplicate is in Reading history");
    assert_eq!(
        row.last_known_path.as_deref(),
        Some(missing.to_string_lossy().into_owned().as_str()),
        "the reader's copy is the candidate's own row"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn moving_a_file_row_to_a_detached_duplicate_clears_the_label() {
    let env = setup().await;
    let present = env.dir.join("present.epub");
    std::fs::copy(minimal_epub(), &present).unwrap();
    let missing = env.dir.join("missing.epub");
    let size = std::fs::metadata(&present).unwrap().len() as i64;

    let candidate = insert(&env.pool, &missing, "Old copy", size).await;
    let owner = insert(&env.pool, &present, "Machine Learning", size).await;
    sqlx::query("UPDATE books SET available = 0 WHERE id = ?1")
        .bind(file_id(&env.pool, candidate).await)
        .execute(&env.pool)
        .await
        .unwrap();
    locate_book(&env.pool, candidate, &present, &env.covers, &[])
        .await
        .unwrap();

    // Identity merges and lifecycle rebinds move a file row by uid update,
    // not by insert. That path must clear the marker too.
    let candidate_uid: String = sqlx::query_scalar("SELECT uid FROM book_records WHERE id = ?1")
        .bind(candidate)
        .fetch_one(&env.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE books SET book_uid = ?1 WHERE id = ?2")
        .bind(&candidate_uid)
        .bind(file_id(&env.pool, owner).await)
        .execute(&env.pool)
        .await
        .unwrap();
    let marked: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM book_detached_duplicates WHERE book_uid = ?1")
            .bind(&candidate_uid)
            .fetch_one(&env.pool)
            .await
            .unwrap();
    assert_eq!(marked, 0, "a rebound record is no longer a duplicate");
}

#[tokio::test(flavor = "multi_thread")]
async fn forgetting_the_owner_keeps_the_label_and_its_title() {
    let env = setup().await;
    let present = env.dir.join("present.epub");
    std::fs::copy(minimal_epub(), &present).unwrap();
    let missing = env.dir.join("missing.epub");
    let size = std::fs::metadata(&present).unwrap().len() as i64;

    let candidate = insert(&env.pool, &missing, "Old copy", size).await;
    let owner = insert(&env.pool, &present, "Machine Learning", size).await;
    sqlx::query("UPDATE books SET available = 0 WHERE id = ?1")
        .bind(file_id(&env.pool, candidate).await)
        .execute(&env.pool)
        .await
        .unwrap();
    locate_book(&env.pool, candidate, &present, &env.covers, &[])
        .await
        .unwrap();

    let owner_uid = uid(&env.pool, owner).await;
    sqlx::query("DELETE FROM books WHERE book_uid = ?1")
        .bind(&owner_uid)
        .execute(&env.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM book_records WHERE uid = ?1")
        .bind(&owner_uid)
        .execute(&env.pool)
        .await
        .unwrap();

    let history = reading_history::list(&env.pool, None).await.unwrap();
    let row = history
        .iter()
        .find(|row| row.id == candidate)
        .expect("the detached duplicate stays in Reading history");
    assert!(row.is_empty_duplicate);
    assert_eq!(
        row.duplicate_of_title.as_deref(),
        Some("Machine Learning"),
        "the snapshotted title outlives the owner record"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn identical_bytes_merge_even_with_reading_state() {
    let env = setup().await;
    let bytes = std::fs::read(minimal_epub()).unwrap();
    let present = env.dir.join("present.epub");
    let missing = env.dir.join("missing.epub");
    std::fs::write(&present, &bytes).unwrap();
    std::fs::write(&missing, &bytes).unwrap();
    let size = bytes.len() as i64;

    let candidate = insert(&env.pool, &missing, "Old copy", size).await;
    let owner = insert(&env.pool, &present, "Machine Learning", size).await;
    bind(&env.pool, candidate, &sha256_hex(&bytes)).await;
    add_state(&env.pool, candidate, 55.0).await;

    let outcome = locate_book(&env.pool, candidate, &present, &env.covers, &[])
        .await
        .unwrap();
    let LocateOutcome::Merged { book, .. } = outcome else {
        panic!("expected identical bytes to merge, got {outcome:?}");
    };
    assert_eq!(book.id, owner);
    let owner_uid = uid(&env.pool, owner).await;
    let annotations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM annotations WHERE book_uid = ?1")
            .bind(&owner_uid)
            .fetch_one(&env.pool)
            .await
            .unwrap();
    assert_eq!(annotations, 1, "the highlight follows the winner");
    let progress: Option<f64> =
        sqlx::query_scalar("SELECT progress_percent FROM reading_progress WHERE book_uid = ?1")
            .bind(&owner_uid)
            .fetch_optional(&env.pool)
            .await
            .unwrap()
            .flatten();
    assert_eq!(progress, Some(55.0));
}

#[tokio::test(flavor = "multi_thread")]
async fn different_bytes_with_state_report_a_conflict_and_change_nothing() {
    let env = setup().await;
    let present = env.dir.join("present.epub");
    std::fs::copy(minimal_epub(), &present).unwrap();
    let missing = env.dir.join("missing.epub");
    let size = std::fs::metadata(&present).unwrap().len() as i64;

    let candidate = insert(&env.pool, &missing, "Old copy", size).await;
    let owner = insert(&env.pool, &present, "Machine Learning", size).await;
    bind(&env.pool, candidate, &"0".repeat(64)).await;
    add_state(&env.pool, candidate, 40.0).await;

    let outcome = locate_book(&env.pool, candidate, &present, &env.covers, &[])
        .await
        .unwrap();
    let LocateOutcome::Conflict { conflict } = outcome else {
        panic!("expected a conflict, got {outcome:?}");
    };
    assert_eq!(conflict.owner.id, owner);
    assert_eq!(conflict.candidate.id, candidate);
    assert!(conflict.candidate_state.has_state());
    assert_eq!(conflict.candidate_state.annotations, 1);
    assert_eq!(conflict.candidate_state.progress_percent, Some(40.0));
    assert!(books::get_book(&env.pool, candidate)
        .await
        .unwrap()
        .is_some());
    assert!(books::get_book(&env.pool, owner).await.unwrap().is_some());
    let candidate_uid = uid(&env.pool, candidate).await;
    let annotations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM annotations WHERE book_uid = ?1")
            .bind(&candidate_uid)
            .fetch_one(&env.pool)
            .await
            .unwrap();
    assert_eq!(annotations, 1, "the highlight stays with the old entry");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_outside_the_library_reconnects_the_missing_book() {
    let env = setup().await;
    let picked = env.dir.join("renamed.epub");
    std::fs::copy(minimal_epub(), &picked).unwrap();
    let missing = env.dir.join("missing.epub");
    let size = std::fs::metadata(&picked).unwrap().len() as i64;
    let candidate = insert(&env.pool, &missing, "Book", size).await;

    let outcome = locate_book(&env.pool, candidate, &picked, &env.covers, &[])
        .await
        .unwrap();
    let LocateOutcome::Reconnected { book } = outcome else {
        panic!("expected a reconnect, got {outcome:?}");
    };
    assert_eq!(book.id, candidate);
    assert_eq!(book.path, picked.to_string_lossy());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_locator_only_progress_row_is_state_and_forces_a_conflict() {
    let env = setup().await;
    let present = env.dir.join("present.epub");
    std::fs::copy(minimal_epub(), &present).unwrap();
    let missing = env.dir.join("missing.epub");
    let size = std::fs::metadata(&present).unwrap().len() as i64;

    let candidate = insert(&env.pool, &missing, "Old copy", size).await;
    insert(&env.pool, &present, "Machine Learning", size).await;
    bind(&env.pool, candidate, &"0".repeat(64)).await;
    let candidate_uid = uid(&env.pool, candidate).await;
    sqlx::query(
        "INSERT INTO reading_progress (book_uid, cfi, chapter_href)
         VALUES (?1, 'epubcfi(/6/4!/4/2)', 'chapter-01.xhtml')",
    )
    .bind(&candidate_uid)
    .execute(&env.pool)
    .await
    .unwrap();

    let outcome = locate_book(&env.pool, candidate, &present, &env.covers, &[])
        .await
        .unwrap();
    let LocateOutcome::Conflict { conflict } = outcome else {
        panic!("expected a conflict, got {outcome:?}");
    };
    assert!(conflict.candidate_state.has_state());
    assert!(conflict.candidate_state.has_progress);
    assert_eq!(conflict.candidate_state.progress_percent, None);
    assert!(books::get_book(&env.pool, candidate)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn picking_another_file_row_of_the_same_book_revives_that_row() {
    let env = setup().await;
    let present = env.dir.join("present.epub");
    let missing = env.dir.join("missing.epub");
    std::fs::copy(minimal_epub(), &present).unwrap();
    let size = std::fs::metadata(&present).unwrap().len() as i64;
    let book = insert(&env.pool, &present, "Book", size).await;
    books::insert_file_for_book(&env.pool, book, &new_book(&missing, "Book", size))
        .await
        .unwrap();
    sqlx::query("UPDATE books SET available = 0 WHERE book_uid = (SELECT uid FROM book_records WHERE id = ?1)")
        .bind(book)
        .execute(&env.pool)
        .await
        .unwrap();

    // The file at the second path comes back; the picker names that row.
    std::fs::copy(minimal_epub(), &missing).unwrap();
    let outcome = locate_book(&env.pool, book, &missing, &env.covers, &[])
        .await
        .unwrap();
    let LocateOutcome::Reconnected { book: refreshed } = outcome else {
        panic!("expected a reconnect, got {outcome:?}");
    };
    assert_eq!(refreshed.id, book);
    assert!(refreshed.available);
    let files = books::list_files_for_book(&env.pool, book).await.unwrap();
    let picked = files
        .iter()
        .find(|file| file.path == missing.to_string_lossy())
        .expect("the picked row stays");
    assert!(picked.available, "the picked row is marked available");
}

#[tokio::test(flavor = "multi_thread")]
async fn edition_link_can_keep_the_target_progress() {
    let env = setup().await;
    let source_path = env.dir.join("source.epub");
    let target_path = env.dir.join("target.epub");
    std::fs::copy(minimal_epub(), &source_path).unwrap();
    std::fs::copy(minimal_epub(), &target_path).unwrap();
    let size = std::fs::metadata(&source_path).unwrap().len() as i64;
    let source = insert(&env.pool, &source_path, "Source", size).await;
    let target = insert(&env.pool, &target_path, "Target", size).await;
    for (book, percent) in [(source, 40.0), (target, 80.0)] {
        sqlx::query("INSERT INTO reading_progress (book_uid, progress_percent) VALUES (?1, ?2)")
            .bind(uid(&env.pool, book).await)
            .bind(percent)
            .execute(&env.pool)
            .await
            .unwrap();
    }

    let outcome = editions::link_editions(&env.pool, source, target, false)
        .await
        .unwrap();
    assert_eq!(outcome.copied_progress_percent, None);
    let target_percent: Option<f64> =
        sqlx::query_scalar("SELECT progress_percent FROM reading_progress WHERE book_uid = ?1")
            .bind(uid(&env.pool, target).await)
            .fetch_optional(&env.pool)
            .await
            .unwrap()
            .flatten();
    assert_eq!(target_percent, Some(80.0), "the target keeps its position");
}
