use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use sqlx::SqlitePool;

use crate::domain::NewBook;
use crate::epub::EpubBook;
use crate::error::AppError;
use crate::repository::books;
use crate::services::library_scanner::{parse_book, scan_directory, ScanError, ScannedBook};

/// Summary of an import run over a library directory.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: u64,
    pub updated: u64,
    pub failed: Vec<FailedImport>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedImport {
    pub path: String,
    pub error: String,
}

/// A single persisted book and whether the upsert newly inserted it.
#[derive(Debug, Clone)]
pub struct ImportOutcome {
    pub book: crate::domain::Book,
    pub inserted: bool,
}

/// Build a [`NewBook`] from an already-parsed document: best-effort cover
/// extraction plus the filesystem snapshot (size/mtime) for change detection.
/// `previous_cover` is the stored cover path of an existing row for the same
/// book (if any); PDF extraction that cannot run (PDFium unavailable, render
/// failure) keeps it instead of downgrading the row to coverless.
pub(crate) fn new_book_from_parsed(
    path: &Path,
    parsed: &ScannedBook,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
    previous_cover: Option<&str>,
) -> Result<NewBook, AppError> {
    std::fs::create_dir_all(covers_dir)?;
    Ok(match parsed {
        ScannedBook::Epub(book) => to_new_book(path, book, write_cover(book, covers_dir)?),
        ScannedBook::Pdf(book) => pdf_to_new_book(
            path,
            book,
            pdf_cover_path(path, covers_dir, pdfium_dirs, previous_cover)?,
        ),
    })
}

/// Import a single file (watcher path): parse, build the book, upsert by
/// path. `Ok(None)` means the file did not parse (e.g. still being written);
/// the caller simply waits for a later event instead of treating it as an
/// error. Errors are real failures (database, cover IO).
pub async fn import_file(
    pool: &SqlitePool,
    path: &Path,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
) -> Result<Option<ImportOutcome>, AppError> {
    let previous_cover = existing_cover(pool, path).await?;
    let parsed = match parse_book(path) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(None),
    };
    let new_book = new_book_from_parsed(
        path,
        &parsed,
        covers_dir,
        pdfium_dirs,
        previous_cover.as_deref(),
    )?;
    let (id, inserted) = books::upsert_book(pool, &new_book).await?;
    let book = books::get_book(pool, id).await?.expect("row just upserted");
    Ok(Some(ImportOutcome { book, inserted }))
}

/// Scan `library_root` for EPUBs and PDFs and persist them (upsert keyed by
/// path). EPUB covers are extracted from the package; PDF covers are
/// rasterized from page 1 with the PDFium libraries probed in `pdfium_dirs`
/// — best-effort in both cases, never an import failure. Files that fail to
/// parse are reported in [`ImportReport::failed`] and do not abort the run.
/// `on_book` runs after each upsert with the persisted row, so callers can
/// stream progress instead of waiting for the whole run.
pub async fn import_directory(
    pool: &SqlitePool,
    library_root: &Path,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
    on_book: &(dyn Fn(&crate::domain::Book) + Send + Sync),
) -> Result<ImportReport, AppError> {
    let entries = scan_directory(library_root).map_err(|err| match err {
        ScanError::Io { source, .. } => AppError::Io(source),
        other => AppError::InvalidInput(other.to_string()),
    })?;

    let mut report = ImportReport::default();
    for entry in entries {
        match &entry.book {
            Err(error) => report.failed.push(FailedImport {
                path: entry.path.to_string_lossy().into_owned(),
                error: error.to_string(),
            }),
            Ok(parsed) => {
                let previous_cover = existing_cover(pool, &entry.path).await?;
                let new_book = new_book_from_parsed(
                    &entry.path,
                    parsed,
                    covers_dir,
                    pdfium_dirs,
                    previous_cover.as_deref(),
                )?;
                let (id, inserted) = books::upsert_book(pool, &new_book).await?;
                if let Some(book) = books::get_book(pool, id).await? {
                    on_book(&book);
                }
                bump(&mut report, inserted);
            }
        }
    }
    Ok(report)
}

fn bump(report: &mut ImportReport, inserted: bool) {
    if inserted {
        report.imported += 1;
    } else {
        report.updated += 1;
    }
}

/// The stored cover of an existing row for `path`, if any — the "keep what
/// works" input for indeterminate PDF extraction.
async fn existing_cover(pool: &SqlitePool, path: &Path) -> Result<Option<String>, AppError> {
    let path_str = path.to_string_lossy().into_owned();
    Ok(books::get_book_by_path(pool, &path_str)
        .await?
        .and_then(|book| book.cover_path))
}

/// Snapshot a file's size and mtime (unix seconds) for change detection.
/// Unreadable files snapshot as `(0, 0)`, which never matches a previously
/// imported book, so the next modification event re-imports instead of
/// skipping — a safe default for transient stat failures.
pub fn file_stats(path: &Path) -> Option<(i64, i64)> {
    let metadata = std::fs::metadata(path).ok()?;
    let size = metadata.len() as i64;
    let mtime = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some((size, mtime))
}

fn to_new_book(path: &Path, book: &EpubBook, cover_path: Option<String>) -> NewBook {
    let (file_size, file_mtime) = file_stats(path).unwrap_or((0, 0));
    NewBook {
        path: path.to_string_lossy().into_owned(),
        title: book.metadata.title.clone(),
        subtitle: None,
        author: book.metadata.author.clone(),
        publisher: book.metadata.publisher.clone(),
        language: book.metadata.language.clone(),
        isbn: book.metadata.isbn.clone(),
        description: book.metadata.description.clone(),
        cover_path,
        file_size,
        file_mtime,
    }
}

fn pdf_to_new_book(path: &Path, book: &crate::pdf::PdfBook, cover_path: Option<String>) -> NewBook {
    let (file_size, file_mtime) = file_stats(path).unwrap_or((0, 0));
    NewBook {
        path: path.to_string_lossy().into_owned(),
        title: book.metadata.title.clone(),
        subtitle: None,
        author: book.metadata.author.clone(),
        publisher: None,
        language: None,
        isbn: None,
        description: book.metadata.description.clone(),
        cover_path,
        file_size,
        file_mtime,
    }
}

/// Rasterize page 1 of a PDF and persist it as the book's cover.
fn pdf_cover_path(
    path: &Path,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
    previous_cover: Option<&str>,
) -> Result<Option<String>, AppError> {
    let rendered = crate::pdf::render_first_page_cover(path, pdfium_dirs);
    pdf_cover_from_result(rendered, covers_dir, previous_cover, path)
}

/// Map a PDF cover-extraction outcome onto the stored `cover_path`. Both
/// "PDFium unavailable" (`Ok(None)`) and a render error are *indeterminate*
/// rather than "definitely no cover", so an existing cover survives: a
/// transient PDFium failure must not strip artwork from rows that already
/// have it. Only a successful render writes a (new) cache entry.
fn pdf_cover_from_result(
    rendered: Result<Option<Vec<u8>>, crate::pdf::PdfError>,
    covers_dir: &Path,
    previous_cover: Option<&str>,
    source_path: &Path,
) -> Result<Option<String>, AppError> {
    match rendered {
        Ok(Some(png)) => write_cover_bytes("image/png", &png, covers_dir),
        Ok(None) => Ok(previous_cover.map(str::to_owned)),
        Err(err) => {
            eprintln!(
                "pdf cover extraction failed for {}: {err}",
                source_path.display()
            );
            Ok(previous_cover.map(str::to_owned))
        }
    }
}

/// Unique suffix for in-progress cache writes so concurrent imports of
/// identical content never write the same temp file.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// FNV-1a: a hash whose value is stable across processes, Rust versions, and
/// rebuilds. Cover cache file names live in the database, so a hash that
/// could change between runs (e.g. `DefaultHasher`) would orphan every
/// stored cover path after a toolchain update.
fn stable_hash(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Write cover bytes into the artwork cache under a content-derived name
/// (`<fnv1a>.<ext>`): identical covers across books, moves, and re-imports
/// share one file, and a source change produces a new name, which is what
/// makes the startup sweep able to invalidate stale artwork. Writing is
/// atomic (temp file + rename) so a crash can never leave a truncated file
/// at a name a later import would treat as a cache hit.
fn write_cover_bytes(
    media_type: &str,
    data: &[u8],
    covers_dir: &Path,
) -> Result<Option<String>, AppError> {
    let extension = match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "img",
    };
    let file_name = format!("{:016x}.{extension}", stable_hash(data));
    let destination = covers_dir.join(&file_name);
    if destination.exists() {
        return Ok(Some(destination.to_string_lossy().into_owned()));
    }

    let temp = covers_dir.join(format!(
        ".tmp-{}-{}",
        stable_hash(data),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&temp, data)?;
    std::fs::rename(&temp, &destination)?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

fn write_cover(book: &EpubBook, covers_dir: &Path) -> Result<Option<String>, AppError> {
    let Some(cover) = &book.cover else {
        return Ok(None);
    };
    write_cover_bytes(&cover.media_type, &cover.data, covers_dir)
}

#[cfg(test)]
mod tests {
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

        assert_eq!(report.imported, 1);
        assert_eq!(report.updated, 0);
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].path.ends_with("bad.epub"));

        assert_eq!(books::count_books(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn reimport_updates_instead_of_duplicating() {
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
        let second = import_directory(&pool, &lib, &covers, &[], &|_| {})
            .await
            .unwrap();
        assert_eq!(second.updated, 1);
        assert_eq!(second.imported, 0);
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
        let pdfium_dirs = crate::pdfium_library_dirs(None);
        if !crate::pdf::render::pdfium_available(&pdfium_dirs) {
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

        let listed = books::list_books(&pool).await.unwrap();
        let path_a = listed[0].cover_path.as_deref().expect("cover a");
        let path_b = listed[1].cover_path.as_deref().expect("cover b");
        assert_eq!(path_a, path_b, "identical content must share one file");

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

        // Same path, different content -> different cache key.
        tmp_epub_with_cover(&lib, "book.epub", Some(b"cover-version-2"));
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
}
