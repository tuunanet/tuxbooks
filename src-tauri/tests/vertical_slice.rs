//! Vertical-slice integration test: fixture EPUB -> scanner -> importer -> SQLite
//! -> repositories -> search index. Exercises the same path the Tauri commands use.

use std::path::Path;
use std::path::PathBuf;

use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::domain::LibraryStats;
use tuxbooks_lib::domain::ProgressUpdate;
use tuxbooks_lib::repository::{
    books, collections,
    reading_progress::{get_progress, mark_finished, upsert_progress},
};
use tuxbooks_lib::services::book_importer::{import_directory, import_file};
use tuxbooks_lib::services::reader::load_book_file;
use tuxbooks_lib::services::search::search_books;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books")
}

fn fixture_epub() -> PathBuf {
    fixture_dir().join("minimal.epub")
}

fn fixture_pdf(name: &str) -> PathBuf {
    fixture_dir().join(name)
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
    let report = import_directory(&pool, &library, &covers, &[], &|_| {}).await?;
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
    let rerun = import_directory(&pool, &library, &covers, &[], &|_| {}).await?;
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

    // Milestone 10: the list payload carries reading progress so the UI can
    // drive the In Progress / Finished sections without extra round trips.
    upsert_progress(
        &pool,
        book.id,
        &ProgressUpdate {
            chapter_href: Some("chapter1.xhtml".into()),
            progress_percent: Some(40.0),
            ..Default::default()
        },
    )
    .await?;
    let listed = books::list_books(&pool).await?;
    assert_eq!(listed[0].progress_percent, Some(40.0));
    assert!(listed[0].progress_updated_at.is_some());

    // Marking finished flips the percent to 100 while the saved position
    // (chapter href) survives for resume.
    mark_finished(&pool, book.id).await?;
    let listed = books::list_books(&pool).await?;
    assert_eq!(listed[0].progress_percent, Some(100.0));
    let progress = get_progress(&pool, book.id).await?.expect("progress row");
    assert_eq!(progress.chapter_href.as_deref(), Some("chapter1.xhtml"));

    // Collection membership shows up in the summary shape behind
    // `list_collections`.
    let favorites = collections::list_collection_summaries(&pool).await?;
    assert_eq!(favorites.len(), 1);
    assert!(favorites[0].book_ids.is_empty());
    collections::add_book_to_collection(&pool, book.id, favorites[0].id).await?;
    let favorites = collections::list_collection_summaries(&pool).await?;
    assert_eq!(favorites[0].book_ids, vec![book.id]);

    Ok(())
}

/// Milestone 10: single-file import — the same `import_file` primitive the
/// `import_paths` command uses for plain files — persists a book outside any
/// watched folder, and an unsupported path lands in the report's failures.
#[tokio::test]
async fn single_file_import_persists_without_a_watched_root() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let library = tmp.path().join("loose files");
    std::fs::create_dir_all(&library)?;
    let file_path = library.join("minimal.epub");
    std::fs::copy(fixture_epub(), &file_path)?;

    let pool = init_pool(&tmp.path().join("t.db")).await?;
    let outcome = import_file(&pool, &file_path, &tmp.path().join("covers"), &[]).await?;
    let outcome = outcome.expect("fixture epub should parse");
    assert!(outcome.inserted);
    assert_eq!(books::count_books(&pool).await?, 1);

    // Re-importing the same file updates in place.
    let rerun = import_file(&pool, &file_path, &tmp.path().join("covers"), &[]).await?;
    assert!(matches!(rerun, Some(ref o) if !o.inserted));
    assert_eq!(books::count_books(&pool).await?, 1);

    // A non-book file is reported, not imported and not fatal.
    let stray = library.join("notes.txt");
    std::fs::write(&stray, b"not a book")?;
    let missing = import_file(&pool, &stray, &tmp.path().join("covers"), &[]).await?;
    assert!(missing.is_none());
    assert_eq!(books::count_books(&pool).await?, 1);

    Ok(())
}

#[tokio::test]
async fn malformed_epub_is_reported_and_does_not_break_the_library() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let library = tmp.path().join("library");
    std::fs::create_dir_all(&library)?;
    std::fs::write(library.join("corrupt.epub"), b"this is not a zip")?;

    let pool = init_pool(&tmp.path().join("t.db")).await?;
    let report =
        import_directory(&pool, &library, &tmp.path().join("covers"), &[], &|_| {}).await?;

    assert_eq!(report.imported, 0);
    assert_eq!(report.failed.len(), 1);
    assert!(report.failed[0].path.ends_with("corrupt.epub"));
    assert_eq!(books::count_books(&pool).await?, 0);
    Ok(())
}

/// Reader slice: every committed fixture PDF imports through the same stack
/// the app uses and its bytes are served back verbatim for the frontend
/// PDF.js engine (lopdf must parse them all). When the PDFium library is
/// installed, the import also rasterizes a page-1 cover.
#[tokio::test]
async fn fixture_pdfs_import_and_serve_their_bytes() -> anyhow::Result<()> {
    let pdfium_dirs = tuxbooks_lib::pdfium_library_dirs(None);
    let covers_expected = tuxbooks_lib::pdf::render::pdfium_available(&pdfium_dirs);

    for name in ["minimal.pdf", "large.pdf", "mixed.pdf"] {
        let tmp = tempfile::tempdir()?;
        let library = tmp.path().join("library");
        std::fs::create_dir_all(&library)?;
        std::fs::copy(fixture_pdf(name), library.join(name))?;

        let covers = tmp.path().join("covers");
        let pool = init_pool(&tmp.path().join("t.db")).await?;
        let report = import_directory(&pool, &library, &covers, &pdfium_dirs, &|_| {}).await?;
        assert_eq!(report.imported, 1, "{name} should import: {report:?}");
        assert!(report.failed.is_empty(), "lopdf must parse {name}");

        let book = &books::list_books(&pool).await?[0];
        let expected = std::fs::read(fixture_pdf(name))?;
        let served = load_book_file(&pool, book.id).await?;
        assert_eq!(served, expected);

        match (&book.cover_path, covers_expected) {
            (Some(path), true) => {
                let png = std::fs::read(path)?;
                assert_eq!(
                    &png[..8],
                    b"\x89PNG\r\n\x1a\n",
                    "{name} cover must be a PNG"
                );
            }
            (None, false) => {}
            got => panic!(
                "{name}: unexpected cover state {got:?} (pdfium installed: {covers_expected})"
            ),
        }
    }
    Ok(())
}
