//! Building a [`NewBook`] from a parsed document.

use std::path::{Path, PathBuf};

use crate::domain::NewBook;
use crate::error::AppError;
use crate::services::library_scanner::ScannedBook;

use super::cover::{pdf_cover_path, write_cover};

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

/// Build the bibliographic [`NewBook`] for an already-parsed document,
/// without touching the artwork cache. Used by metadata embedding to refresh
/// the source snapshot from a rewritten file (the caller preserves the
/// existing cover path, since covers are not embedded).
pub(crate) fn bibliographic_new_book(
    path: &Path,
    parsed: &ScannedBook,
    cover_path: Option<String>,
) -> NewBook {
    match parsed {
        ScannedBook::Epub(book) => to_new_book(path, book, cover_path),
        ScannedBook::Pdf(book) => pdf_to_new_book(path, book, cover_path),
    }
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

fn to_new_book(path: &Path, book: &crate::epub::EpubBook, cover_path: Option<String>) -> NewBook {
    let (file_size, file_mtime) = file_stats(path).unwrap_or((0, 0));
    let metadata = &book.metadata;
    NewBook {
        path: path.to_string_lossy().into_owned(),
        title: metadata.title.clone(),
        subtitle: metadata.subtitle.clone(),
        author: metadata.author.clone(),
        authors: metadata.authors.clone(),
        subjects: metadata.subjects.clone(),
        publisher: metadata.publisher.clone(),
        language: metadata.language.clone(),
        isbn: metadata.isbn.clone(),
        description: metadata.description.clone(),
        publication_date: metadata.publication_date.clone(),
        series: metadata.series.clone(),
        series_index: metadata.series_index,
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
        authors: book.metadata.author.iter().cloned().collect(),
        subjects: Vec::new(),
        publisher: None,
        language: None,
        isbn: None,
        description: book.metadata.description.clone(),
        publication_date: None,
        series: None,
        series_index: None,
        cover_path,
        file_size,
        file_mtime,
    }
}
