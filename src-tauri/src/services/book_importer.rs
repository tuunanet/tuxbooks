use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::path::PathBuf;

use sqlx::SqlitePool;

use crate::domain::NewBook;
use crate::epub::EpubBook;
use crate::error::AppError;
use crate::repository::books;
use crate::services::library_scanner::{scan_directory, ScanError, ScannedBook};

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

    std::fs::create_dir_all(covers_dir)?;

    let mut report = ImportReport::default();
    for entry in entries {
        match entry.book {
            Err(error) => report.failed.push(FailedImport {
                path: entry.path.to_string_lossy().into_owned(),
                error: error.to_string(),
            }),
            Ok(ScannedBook::Epub(parsed)) => {
                let cover_path = write_cover(&parsed, covers_dir, &entry.path)?;
                let new_book = to_new_book(&entry.path, &parsed, cover_path);
                let inserted = persist(pool, &new_book, on_book).await?;
                bump(&mut report, inserted);
            }
            Ok(ScannedBook::Pdf(parsed)) => {
                let cover_path = pdf_cover_path(&entry.path, covers_dir, pdfium_dirs)?;
                let new_book = pdf_to_new_book(&entry.path, &parsed, cover_path);
                let inserted = persist(pool, &new_book, on_book).await?;
                bump(&mut report, inserted);
            }
        }
    }
    Ok(report)
}

/// Upsert and hand the persisted row to the progress callback.
async fn persist(
    pool: &SqlitePool,
    new_book: &NewBook,
    on_book: &(dyn Fn(&crate::domain::Book) + Send + Sync),
) -> Result<bool, AppError> {
    let (id, inserted) = books::upsert_book(pool, new_book).await?;
    if let Some(book) = books::get_book(pool, id).await? {
        on_book(&book);
    }
    Ok(inserted)
}

fn bump(report: &mut ImportReport, inserted: bool) {
    if inserted {
        report.imported += 1;
    } else {
        report.updated += 1;
    }
}

fn to_new_book(path: &Path, book: &EpubBook, cover_path: Option<String>) -> NewBook {
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
    }
}

fn pdf_to_new_book(path: &Path, book: &crate::pdf::PdfBook, cover_path: Option<String>) -> NewBook {
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
    }
}

/// Rasterize page 1 of a PDF and persist it as the book's cover. A PDF
/// imports without a cover when PDFium is unavailable (`Ok(None)`) or the
/// page fails to render — metadata already parsed via lopdf stands on its own.
fn pdf_cover_path(
    path: &Path,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
) -> Result<Option<String>, AppError> {
    match crate::pdf::render_first_page_cover(path, pdfium_dirs) {
        Ok(Some(png)) => write_cover_bytes("image/png", &png, covers_dir, path),
        Ok(None) => Ok(None),
        Err(err) => {
            eprintln!("pdf cover extraction failed for {}: {err}", path.display());
            Ok(None)
        }
    }
}

fn write_cover_bytes(
    media_type: &str,
    data: &[u8],
    covers_dir: &Path,
    source_path: &Path,
) -> Result<Option<String>, AppError> {
    let extension = match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "img",
    };
    let mut hasher = DefaultHasher::new();
    source_path.hash(&mut hasher);
    let file_name = format!("{:016x}.{extension}", hasher.finish());

    let destination = covers_dir.join(file_name);
    std::fs::write(&destination, data)?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

fn write_cover(
    book: &EpubBook,
    covers_dir: &Path,
    source_path: &Path,
) -> Result<Option<String>, AppError> {
    let Some(cover) = &book.cover else {
        return Ok(None);
    };
    write_cover_bytes(&cover.media_type, &cover.data, covers_dir, source_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::init_pool;
    use crate::epub::parser::tests_support::write_zip;
    use std::path::PathBuf;

    fn tmp_epub(dir: &Path, name: &str) -> PathBuf {
        write_zip(
            &dir.join(name),
            &[
                ("mimetype", "application/epub+zip".as_bytes()),
                (
                    "META-INF/container.xml",
                    br#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#,
                ),
                (
                    "content.opf",
                    br#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:language>en</dc:language></metadata>
<manifest/>
<spine/>
</package>"#,
                ),
            ],
        );
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
}
