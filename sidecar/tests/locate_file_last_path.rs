//! The Last known path written by the Locate duplicate detach (tuxbooks-t9p.1).
//! Split from `locate_file.rs` to keep each test crate under the file limit.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tempfile::TempDir;
use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::NewBook;
use tuxbooks_lib::repository::{books, reading_history};
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

async fn file_id(pool: &SqlitePool, book_id: i64) -> i64 {
    books::file_ids_for_book(pool, book_id)
        .await
        .unwrap()
        .first()
        .copied()
        .unwrap()
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
    let _owner = insert(&env.pool, &present, "Machine Learning", size).await;
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
