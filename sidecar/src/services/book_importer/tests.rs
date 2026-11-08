//! Import and artwork-cache tests.
//!
//! Cover rasterization runs in the document worker (P-1): the worker binary
//! (`cargo build --bin tuxbooks-worker`) must have been built, and the
//! rasterizing test self-skips when the PDFium library was not fetched
//! (just fetch-pdfium).

use super::*;
use crate::db::connection::init_pool;
use crate::epub::parser::tests_support::write_zip;
use std::path::PathBuf;

fn tmp_epub(dir: &Path, name: &str) -> PathBuf {
    tmp_epub_with_cover(dir, name, None)
}

/// EPUB fixture with an optional cover manifest item whose payload is
/// `cover` verbatim (so tests can supply valid images or garbage).
fn tmp_epub_with_cover(dir: &Path, name: &str, cover: Option<&[u8]>) -> PathBuf {
    let manifest = match cover {
        Some(_) => {
            r#"<manifest><item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/></manifest>"#
        }
        None => r#"<manifest/>"#,
    };
    let opf = format!(
        r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:language>en</dc:language></metadata>
{manifest}
<spine/>
</package>"#
    );
    let mut entries: Vec<(&str, &[u8])> = vec![
        ("mimetype", "application/epub+zip".as_bytes()),
        (
            "META-INF/container.xml",
            br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
        ),
        ("content.opf", opf.as_bytes()),
    ];
    if let Some(bytes) = cover {
        entries.push(("cover.png", bytes));
    }
    write_zip(&dir.join(name), &entries);
    dir.join(name)
}

#[tokio::test]
async fn imports_into_database_and_reports_failures() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    std::fs::create_dir_all(&lib).unwrap();
    tmp_epub(&lib, "good.epub");
    std::fs::write(lib.join("bad.epub"), b"junk").unwrap();
    std::fs::write(lib.join("note.txt"), b"ignored").unwrap();

    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let report = import_directory(&pool, &lib, &tmp.path().join("covers"), &[], &|_| {})
        .await
        .unwrap();

    assert_eq!(report.imported, 1, "{report:?}");
    assert_eq!(report.updated, 0);
    assert_eq!(report.failed.len(), 1);
    assert!(report.failed[0].path.ends_with("bad.epub"));

    assert_eq!(books::count_books(&pool).await.unwrap(), 1);
}

#[tokio::test]
async fn reimport_skips_unchanged_files_and_reparses_on_change() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    std::fs::create_dir_all(&lib).unwrap();
    tmp_epub(&lib, "book.epub");

    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let covers = tmp.path().join("covers");

    let first = import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();
    assert_eq!(first.imported, 1);
    assert_eq!(first.skipped, 0);

    // Second run: size+mtime still match — a stat-only pass.
    let second = import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();
    assert_eq!(second.skipped, 1);
    assert_eq!(second.updated, 0);
    assert_eq!(second.imported, 0);
    assert_eq!(books::count_books(&pool).await.unwrap(), 1);

    // A changed file (mtime moved) is re-parsed as an update.
    let path = lib.join("book.epub");
    let previous = std::fs::metadata(&path).unwrap().modified().unwrap();
    let file = std::fs::File::open(&path).unwrap();
    file.set_times(
        std::fs::FileTimes::new().set_modified(previous + std::time::Duration::from_secs(10)),
    )
    .unwrap();
    drop(file);
    let third = import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();
    assert_eq!(third.skipped, 0);
    assert_eq!(third.updated, 1);
    assert_eq!(third.imported, 0);
    assert_eq!(books::count_books(&pool).await.unwrap(), 1);
}

#[tokio::test]
async fn nonexistent_library_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let err = import_directory(
        &pool,
        &tmp.path().join("nope"),
        &tmp.path().join("c"),
        &[],
        &|_| {},
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Io(_)), "got: {err:?}");
}

/// The progress callback must fire once per imported book with the
/// persisted row (id assigned, cover written) — the streaming-UI contract.
#[tokio::test]
async fn progress_callback_reports_each_persisted_book() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    std::fs::create_dir_all(&lib).unwrap();
    tmp_epub(&lib, "one.epub");
    tmp_epub(&lib, "two.epub");

    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let seen = std::sync::Mutex::new(Vec::new());
    let report = import_directory(
        &pool,
        &lib,
        &tmp.path().join("covers"),
        &[],
        &|book: &crate::domain::Book| seen.lock().unwrap().push(book.clone()),
    )
    .await
    .unwrap();

    assert_eq!(report.imported, 2);
    let seen = seen.into_inner().unwrap();
    assert_eq!(seen.len(), 2);
    for book in &seen {
        assert!(book.id > 0, "callback must receive the persisted row");
        assert_eq!(book.title, "T");
    }
}

/// Uses the committed fixture PDF so the cover is rasterized from a
/// realistic document (text + vector content, no embedded images).
#[tokio::test]
async fn pdf_import_writes_a_rasterized_cover_when_pdfium_is_available() {
    let pdfium_dirs = crate::pdfium_library_dirs();
    if !crate::pdf::render::pdfium_is_available(&pdfium_dirs) {
        eprintln!("skipping: no pdfium library fetched (just fetch-pdfium)");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    std::fs::create_dir_all(&lib).unwrap();
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/books/minimal.pdf");
    std::fs::copy(&fixture, lib.join("minimal.pdf")).unwrap();

    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let covers = tmp.path().join("covers");
    let report = import_directory(&pool, &lib, &covers, &pdfium_dirs, &|_| {})
        .await
        .unwrap();
    assert_eq!(report.imported, 1, "{report:?}");

    let book = &books::list_books(&pool).await.unwrap()[0];
    let cover_path = book.cover_path.as_deref().expect("pdf cover should exist");
    let png = std::fs::read(cover_path).unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    assert!(
        png.len() > 1_000,
        "cover suspiciously small: {} bytes",
        png.len()
    );
}

// ---- Artwork cache (milestone 4) ----

/// Content-addressed keys: identical cover bytes share one cache file,
/// and the second import is a cache hit (no rewrite, no duplicate).
#[tokio::test]
async fn identical_cover_content_shares_one_cache_file() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    std::fs::create_dir_all(&lib).unwrap();
    tmp_epub_with_cover(&lib, "one.epub", Some(b"pngbytes-1"));
    tmp_epub_with_cover(&lib, "two.epub", Some(b"pngbytes-1"));

    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let covers = tmp.path().join("covers");
    let report = import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();
    assert_eq!(report.imported, 2, "{report:?}");

    // Exact duplicate bytes share one durable book, so the library shows
    // one entry even though both locations exist.
    let listed = books::list_books(&pool).await.unwrap();
    assert_eq!(listed.len(), 1, "duplicate bytes collapse to one book");
    let path_a = listed[0].cover_path.as_deref().expect("cover");
    let file_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(file_rows, 2, "both locations are kept");

    let files: Vec<_> = std::fs::read_dir(&covers).unwrap().flatten().collect();
    assert_eq!(files.len(), 1, "exactly one cache file");

    // A cache hit must not rewrite the file: the bytes stay identical.
    let before = std::fs::read(path_a).unwrap();
    std::fs::remove_file(path_a).unwrap();
    tmp_epub_with_cover(&lib, "three.epub", Some(b"pngbytes-1"));
    import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();
    let after = std::fs::read(path_a).unwrap();
    assert_eq!(before, after, "cache-miss rewrite must restore content");
}

/// A moved file re-imported at its new location (the watcher's
/// move-recovery path) reuses the existing cache entry: no re-extraction
/// artifact, no orphaned file, same cover path in the row.
#[tokio::test]
async fn moved_file_reimport_reuses_cached_cover() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    std::fs::create_dir_all(&lib).unwrap();
    let original = tmp_epub_with_cover(&lib, "book.epub", Some(b"pngbytes-move"));

    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let covers = tmp.path().join("covers");
    import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();
    let before = books::list_books(&pool).await.unwrap()[0]
        .cover_path
        .clone()
        .expect("cover exists");

    let moved = lib.join("renamed.epub");
    std::fs::rename(&original, &moved).unwrap();
    let outcome = import_file(&pool, &moved, &covers, &[])
        .await
        .unwrap()
        .expect("parses");
    assert!(outcome.inserted, "a moved file imports as a fresh row");

    let files: Vec<_> = std::fs::read_dir(&covers).unwrap().flatten().collect();
    assert_eq!(files.len(), 1, "move must not duplicate the cache entry");
    assert_eq!(
        outcome.book.cover_path.as_deref(),
        Some(before.as_str()),
        "same content -> same cache path"
    );
}

/// Invalidates when the source changes: the modified book references a
/// fresh cache file, the stale one becomes unreferenced garbage, and a
/// sweep collects exactly that garbage.
#[tokio::test]
async fn changed_cover_gets_new_file_and_sweep_invalidates_old() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    std::fs::create_dir_all(&lib).unwrap();
    let book_file = tmp_epub_with_cover(&lib, "book.epub", Some(b"cover-version-1"));
    assert!(book_file.exists());

    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let covers = tmp.path().join("covers");
    import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();
    let old_cover = books::list_books(&pool).await.unwrap()[0]
        .cover_path
        .clone()
        .expect("v1 cover");

    // Same path, different content -> different cache key. The rewrite
    // is same-length within the same second, so size+mtime would still
    // match — bump mtime explicitly to simulate a real modification
    // (the skip-if-unchanged contract sees it, and re-parses).
    tmp_epub_with_cover(&lib, "book.epub", Some(b"cover-version-2"));
    let previous = std::fs::metadata(&book_file).unwrap().modified().unwrap();
    std::fs::File::open(&book_file)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new().set_modified(previous + std::time::Duration::from_secs(10)),
        )
        .unwrap();
    import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();
    let new_cover = books::list_books(&pool).await.unwrap()[0]
        .cover_path
        .clone()
        .expect("v2 cover");
    assert_ne!(old_cover, new_cover, "source change must move the key");

    let removed = crate::services::artwork_cache::sweep_unreferenced_covers(&pool, &covers)
        .await
        .unwrap();
    assert_eq!(removed, 1);
    assert!(!Path::new(&old_cover).exists(), "stale cover swept");
    assert!(Path::new(&new_cover).exists(), "live cover kept");
    assert_eq!(
        books::list_books(&pool).await.unwrap()[0].cover_path,
        Some(new_cover)
    );
}

/// Corrupt cover payloads are tolerated: the import succeeds and the
/// bytes are cached as-is; the frontend's load-error placeholder is the
/// display fallback for undecodable artwork.
#[tokio::test]
async fn corrupt_cover_bytes_do_not_fail_import() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    std::fs::create_dir_all(&lib).unwrap();
    tmp_epub_with_cover(&lib, "broken.epub", Some(b"\x00\xffnot-an-image"));

    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let covers = tmp.path().join("covers");
    let report = import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();

    assert_eq!(report.imported, 1, "{report:?}");
    assert!(report.failed.is_empty());
    let book = &books::list_books(&pool).await.unwrap()[0];
    let cover_path = book.cover_path.as_deref().expect("bytes are cached as-is");
    assert_eq!(std::fs::read(cover_path).unwrap(), b"\x00\xffnot-an-image");
}

/// An EPUB whose source change removes the cover must drop the stored
/// cover path (definitely-absent is distinct from PDF's indeterminate).
#[tokio::test]
async fn epub_cover_removal_clears_the_stored_path() {
    let tmp = tempfile::tempdir().unwrap();
    let lib = tmp.path().join("library");
    std::fs::create_dir_all(&lib).unwrap();
    tmp_epub_with_cover(&lib, "book.epub", Some(b"pngbytes-gone"));

    let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
    let covers = tmp.path().join("covers");
    import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();
    assert!(books::list_books(&pool).await.unwrap()[0]
        .cover_path
        .is_some());

    // The source change drops the cover item entirely.
    tmp_epub(&lib, "book.epub");
    import_directory(&pool, &lib, &covers, &[], &|_| {})
        .await
        .unwrap();
    assert_eq!(
        books::list_books(&pool).await.unwrap()[0].cover_path,
        None,
        "absent cover must invalidate the old reference"
    );
}

/// PDF covers are indeterminate when extraction cannot run: "PDFium
/// unavailable" and "render failed" must keep the row's existing
/// artwork instead of downgrading to coverless. Tested against the
/// decision function directly — whether PDFium loads is environment-
/// dependent, and even a successful re-render may not be byte-identical.
#[test]
fn pdf_cover_indeterminate_outcomes_preserve_previous_cover() {
    let tmp = tempfile::tempdir().unwrap();
    let covers = tmp.path().join("covers");
    std::fs::create_dir_all(&covers).unwrap();
    let previous = covers.join("existing.png");
    std::fs::write(&previous, b"existing-png").unwrap();
    let previous_str = previous.to_string_lossy().into_owned();
    let source = Path::new("/lib/book.pdf");

    let unavailable =
        pdf_cover_from_result(Ok(None), &covers, Some(&previous_str), source).unwrap();
    assert_eq!(unavailable.as_deref(), Some(previous_str.as_str()));

    let failed = pdf_cover_from_result(
        Err(crate::pdf::PdfError::Render("boom".into())),
        &covers,
        Some(&previous_str),
        source,
    )
    .unwrap();
    assert_eq!(failed.as_deref(), Some(previous_str.as_str()));

    // No previous cover: indeterminate stays coverless, never an error.
    let fresh = pdf_cover_from_result(Ok(None), &covers, None, source).unwrap();
    assert_eq!(fresh, None);
}

/// A successful render always wins over the previous cover: the new
/// bytes become the cache entry the row references.
#[test]
fn pdf_cover_rendered_result_replaces_previous_cover() {
    let tmp = tempfile::tempdir().unwrap();
    let covers = tmp.path().join("covers");
    std::fs::create_dir_all(&covers).unwrap();
    let previous = covers.join("existing.png");
    std::fs::write(&previous, b"existing-png").unwrap();
    let previous_str = previous.to_string_lossy().into_owned();

    let png = b"\x89PNG\r\n\x1a\n fresh render";
    let updated = pdf_cover_from_result(
        Ok(Some(png.to_vec())),
        &covers,
        Some(previous_str.as_str()),
        Path::new("/lib/book.pdf"),
    )
    .unwrap();

    let updated = updated.expect("a rendered cover is stored");
    assert_ne!(updated, previous_str, "different content -> new cache key");
    assert_eq!(std::fs::read(&updated).unwrap(), png);
}
