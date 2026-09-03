//! Integration test against the realistic user-created library.
//!
//! The library contains real copyrighted books, so it is never committed: it
//! lives at `tests/fixtures/books/EBooks` (gitignored) or wherever
//! `REALISTIC_LIBRARY_PATH` points. The test skips with a notice when the
//! path is absent, so CI and fresh clones stay green.

use std::path::{Path, PathBuf};

use tuxbooks_lib::db::connection::init_pool;
use tuxbooks_lib::services::book_importer::import_directory;
use tuxbooks_lib::services::library_scanner::scan_directory;
use tuxbooks_lib::services::search::search_books;

/// Resolves the realistic library location, or `None` when the user has not
/// placed one on this machine.
fn realistic_library() -> Option<PathBuf> {
    let from_env = std::env::var("REALISTIC_LIBRARY_PATH")
        .ok()
        .filter(|value| !value.is_empty());
    let path = from_env.map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/books/EBooks")
    });
    path.is_dir().then_some(path)
}

/// Every .epub/.pdf file on disk (recursive), the size the import must account for.
fn count_book_files(root: &Path) -> usize {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            entry.path().extension().is_some_and(|ext| {
                ext.eq_ignore_ascii_case("epub") || ext.eq_ignore_ascii_case("pdf")
            })
        })
        .count()
}

#[tokio::test]
async fn realistic_library_imports_every_book_file() {
    let Some(root) = realistic_library() else {
        eprintln!(
            "skipping realistic-library test: no library at tests/fixtures/books/EBooks \
             (or set REALISTIC_LIBRARY_PATH)"
        );
        return;
    };

    let expected_files = count_book_files(&root);
    assert!(expected_files > 0, "realistic library is empty: {root:?}");

    // Scan first: the scanner must discover every book file.
    let entries = scan_directory(&root).expect("scan should succeed for a directory");
    assert_eq!(
        entries.len(),
        expected_files,
        "scanner must discover every .epub/.pdf file under {root:?}"
    );
    let epubs = entries
        .iter()
        .filter(|entry| {
            entry
                .path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("epub"))
        })
        .count();
    let pdfs = entries
        .iter()
        .filter(|entry| {
            entry
                .path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        })
        .count();
    if epubs == 0 || pdfs == 0 {
        eprintln!("skipping format-split assertions: library has only one format");
    }

    // Full import into an isolated database.
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("tuxbooks.db")).await.unwrap();
    let covers = tmp.path().join("covers");
    let report = import_directory(&pool, &root, &covers, &[], &|_| {})
        .await
        .unwrap();
    eprintln!(
        "realistic library: {} files discovered, {} imported, {} failed",
        expected_files,
        report.imported,
        report.failed.len()
    );

    assert_eq!(
        report.imported as usize + report.failed.len(),
        expected_files,
        "every scanned file must import or be reported: {report:?}"
    );
    assert_eq!(report.updated, 0, "fresh database means no updates");
    for failure in &report.failed {
        let path = Path::new(&failure.path);
        assert!(
            path.extension().is_some_and(
                |ext| ext.eq_ignore_ascii_case("epub") || ext.eq_ignore_ascii_case("pdf")
            ),
            "failures must still be book files: {failure:?}"
        );
    }

    // Imported books are searchable and always carry a usable title.
    let all = tuxbooks_lib::repository::books::list_books(&pool)
        .await
        .unwrap();
    assert_eq!(
        all.len(),
        report.imported as usize,
        "database row count matches the import report"
    );
    for book in &all {
        assert!(!book.title.trim().is_empty(), "title for {}", book.path);
    }

    // FTS picks up an imported title (trigger-synced index).
    if let Some(first) = all.first() {
        let needle = first
            .title
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .replace(['"', '*'], "");
        if !needle.is_empty() {
            let hits = search_books(&pool, &needle).await.unwrap();
            assert!(!hits.is_empty(), "FTS should find {needle:?}");
        }
    }

    // Re-import updates in place instead of duplicating.
    let rerun = import_directory(&pool, &root, &covers, &[], &|_| {})
        .await
        .unwrap();
    assert_eq!(
        rerun.imported, 0,
        "second run must update, not duplicate: {rerun:?}"
    );
    assert_eq!(
        tuxbooks_lib::repository::books::count_books(&pool)
            .await
            .unwrap(),
        all.len() as i64
    );
}
