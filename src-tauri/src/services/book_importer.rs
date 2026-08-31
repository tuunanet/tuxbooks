use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

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
/// path). EPUB covers are extracted to `covers_dir`; PDFs carry no extractable
/// cover, so they index without one. Files that fail to parse are reported in
/// [`ImportReport::failed`] and do not abort the run.
pub async fn import_directory(
    pool: &SqlitePool,
    library_root: &Path,
    covers_dir: &Path,
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
                let (_id, inserted) = books::upsert_book(pool, &new_book).await?;
                bump(&mut report, inserted);
            }
            Ok(ScannedBook::Pdf(parsed)) => {
                let new_book = pdf_to_new_book(&entry.path, &parsed);
                let (_id, inserted) = books::upsert_book(pool, &new_book).await?;
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

fn pdf_to_new_book(path: &Path, book: &crate::pdf::PdfBook) -> NewBook {
    NewBook {
        path: path.to_string_lossy().into_owned(),
        title: book.metadata.title.clone(),
        subtitle: None,
        author: book.metadata.author.clone(),
        publisher: None,
        language: None,
        isbn: None,
        description: book.metadata.description.clone(),
        cover_path: None,
    }
}

fn write_cover(
    book: &EpubBook,
    covers_dir: &Path,
    source_path: &Path,
) -> Result<Option<String>, AppError> {
    let Some(cover) = &book.cover else {
        return Ok(None);
    };
    let extension = match cover.media_type.as_str() {
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
    std::fs::write(&destination, &cover.data)?;
    Ok(Some(destination.to_string_lossy().into_owned()))
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
        let report = import_directory(&pool, &lib, &tmp.path().join("covers"))
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

        let first = import_directory(&pool, &lib, &covers).await.unwrap();
        assert_eq!(first.imported, 1);
        let second = import_directory(&pool, &lib, &covers).await.unwrap();
        assert_eq!(second.updated, 1);
        assert_eq!(second.imported, 0);
        assert_eq!(books::count_books(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn nonexistent_library_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.db")).await.unwrap();
        let err = import_directory(&pool, &tmp.path().join("nope"), &tmp.path().join("c"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Io(_)), "got: {err:?}");
    }
}
