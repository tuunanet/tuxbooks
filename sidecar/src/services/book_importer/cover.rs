//! Cover extraction and the artwork cache.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::repository::books;

/// The stored cover of an existing row for `path`, if any — the "keep what
/// works" input for indeterminate PDF extraction.
pub(super) async fn existing_cover(
    pool: &SqlitePool,
    path: &Path,
) -> Result<Option<String>, AppError> {
    let path_str = path.to_string_lossy().into_owned();
    Ok(books::get_book_by_path(pool, &path_str)
        .await?
        .and_then(|book| book.cover_path))
}

/// Rasterize page 1 of a PDF and persist it as the book's cover. PDFium
/// runs only in the document worker (P-1); a worker failure stays an
/// indeterminate cover outcome, never an import failure.
pub(super) fn pdf_cover_path(
    path: &Path,
    covers_dir: &Path,
    pdfium_dirs: &[PathBuf],
    previous_cover: Option<&str>,
) -> Result<Option<String>, AppError> {
    let client = crate::worker::WorkerClient::locate()?;
    let rendered = client
        .pdf_cover(path, pdfium_dirs, &crate::limits::ResourceLimits::DEFAULTS)
        .map_err(|err| crate::pdf::PdfError::Render(err.to_string()));
    pdf_cover_from_result(rendered, covers_dir, previous_cover, path)
}

/// Map a PDF cover-extraction outcome onto the stored `cover_path`. Both
/// "PDFium unavailable" (`Ok(None)`) and a render error are *indeterminate*
/// rather than "definitely no cover", so an existing cover survives: a
/// transient PDFium failure must not strip artwork from rows that already
/// have it. Only a successful render writes a (new) cache entry.
pub(super) fn pdf_cover_from_result(
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
/// at a name a later import would treat as a cache hit. Also used by the
/// metadata service for user-uploaded cover overrides (milestone 7).
pub(crate) fn write_cover_bytes(
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

pub(super) fn write_cover(
    book: &crate::epub::EpubBook,
    covers_dir: &Path,
) -> Result<Option<String>, AppError> {
    let Some(cover) = &book.cover else {
        return Ok(None);
    };
    write_cover_bytes(&cover.media_type, &cover.data, covers_dir)
}
