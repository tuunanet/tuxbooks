//! Vertical-slice integration test: fixture EPUB -> scanner -> importer -> SQLite
//! -> repositories -> search index. Exercises the same path the Tauri commands use.

use std::path::Path;
use std::path::PathBuf;

use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::LibraryStats;
use tuxbooks_lib::repository::{books, collections};
use tuxbooks_lib::services::book_importer::import_directory;
use tuxbooks_lib::services::reader::load_book_file;
use tuxbooks_lib::services::search::search_books;

fn fixture_epub() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/minimal.epub")
}

fn fixture_pdf() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/minimal.pdf")
}

#[tokio::test]
async fn fixture_flows_through_the_whole_stack() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;

    // Isolated test library: the fixture is copied in; nothing outside tmp is touched.
    let library = tmp.path().join("library");
    std::fs::create_dir_all(&library)?;
    std::fs::copy(fixture_epub(), library.join("minimal.epub"))?;

    let db_path = tmp.path().join("tuxbooks.db");
    let pool = init_pool(&db_path).await?;

    let stats_before = LibraryStats {
        book_count: books::count_books(&pool).await?,
        collection_count: collections::count_collections(&pool).await?,
    };
    assert_eq!(stats_before.book_count, 0);

    let covers = tmp.path().join("covers");
    let report = import_directory(&pool, &library, &covers).await?;
    assert_eq!(report.imported, 1, "fixture should import: {report:?}");
    assert!(report.failed.is_empty());

    let all_books = books::list_books(&pool).await?;
    assert_eq!(all_books.len(), 1);
    let book = &all_books[0];
    assert_eq!(book.title, "A Minimal Book");
    assert_eq!(book.author.as_deref(), Some("Ada Lovelace"));
    assert_eq!(book.language.as_deref(), Some("en"));
    assert_eq!(book.isbn.as_deref(), Some("978-3-16-148410-0"));
    assert!(
        book.cover_path.is_some(),
        "fixture cover should be extracted"
    );
    assert!(Path::new(book.cover_path.as_deref().unwrap()).exists());

    // Full-text search sees the imported book.
    let hits = search_books(&pool, "minimal").await?;
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].book_id, book.id);

    // Re-import must update in place, not duplicate.
    let rerun = import_directory(&pool, &library, &covers).await?;
    assert_eq!(rerun.updated, 1);
    assert_eq!(rerun.imported, 0);
    assert_eq!(books::count_books(&pool).await?, 1);

    // Collections count feeds the same stats command shape the frontend gets.
    collections::create_collection(&pool, "Favorites").await?;
    let stats_after = LibraryStats {
        book_count: books::count_books(&pool).await?,
        collection_count: collections::count_collections(&pool).await?,
    };
    assert_eq!(stats_after.book_count, 1);
    assert_eq!(stats_after.collection_count, 1);

    Ok(())
}

#[tokio::test]
async fn malformed_epub_is_reported_and_does_not_break_the_library() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let library = tmp.path().join("library");
    std::fs::create_dir_all(&library)?;
    std::fs::write(library.join("corrupt.epub"), b"this is not a zip")?;

    let pool = init_pool(&tmp.path().join("t.db")).await?;
    let report = import_directory(&pool, &library, &tmp.path().join("covers")).await?;

    assert_eq!(report.imported, 0);
    assert_eq!(report.failed.len(), 1);
    assert!(report.failed[0].path.ends_with("corrupt.epub"));
    assert_eq!(books::count_books(&pool).await?, 0);
    Ok(())
}

/// Reader slice: the fixture PDF imports through the same stack the app uses
/// and its bytes are served back verbatim for the frontend PDF.js engine.
#[tokio::test]
async fn fixture_pdf_imports_and_serves_its_bytes() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let library = tmp.path().join("library");
    std::fs::create_dir_all(&library)?;
    std::fs::copy(fixture_pdf(), library.join("minimal.pdf"))?;

    let pool = init_pool(&tmp.path().join("t.db")).await?;
    let report = import_directory(&pool, &library, &tmp.path().join("covers")).await?;
    assert_eq!(report.imported, 1, "fixture should import: {report:?}");
    assert!(
        report.failed.is_empty(),
        "lopdf must parse the committed fixture"
    );

    let book = &books::list_books(&pool).await?[0];
    assert_eq!(book.title, "A Minimal Manual");

    let expected = std::fs::read(fixture_pdf())?;
    let served = load_book_file(&pool, book.id).await?;
    assert_eq!(served, expected);
    Ok(())
}
