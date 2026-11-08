//! Book file blobs: content-addressed by the file's SHA-256
//! (`<64 hex>.<ext>`), staged from the local book file before a
//! `file_version` operation is published (ADR 0018 D2). The sibling of the
//! cover channel; the same untrusted-folder rules apply. The name grammar is
//! the traversal defense, and the staging call re-verifies the hash so a name
//! can never outlive its content.

use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::AppError;

use super::io::write_bytes_atomic;

pub const BOOK_BLOB_DIR: &str = "blobs/books";
/// The cap bounds one blob (ADR 0018 D2). Only shrinking the file or raising
/// the cap fixes an oversize book; no schedule can, so the issue the staging
/// records is skipped by the auto-retry sweep.
pub const MAX_BOOK_BLOB_BYTES: u64 = 256 * 1024 * 1024;

/// The extensions the import path accepts (`domain::BookFormat`). Keep in
/// sync with `BookFormat::from_extension`.
const BOOK_BLOB_EXTENSIONS: [&str; 2] = ["epub", "pdf"];

/// The name is the only path component that crosses the sync boundary: the
/// full 64-hex SHA-256 plus a book extension. Anything else — traversal,
/// short stems, other extensions, dot files — never matches.
pub fn book_blob_name(path: &str) -> Option<String> {
    let name = Path::new(path).file_name()?.to_str()?;
    let (stem, extension) = name.rsplit_once('.')?;
    if stem.len() != 64 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    if !BOOK_BLOB_EXTENSIONS.contains(&extension) {
        return None;
    }
    Some(name.to_string())
}

/// The outcome of one staging attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookBlobStage {
    /// The blob is in the sync folder under its exact content address
    /// (freshly written, or already present from an earlier stage).
    Stored,
    /// The source is over the 256 MiB cap; nothing was written.
    Oversize,
}

/// Stage the book file's bytes into the sync folder. `hash` must be the
/// SHA-256 the caller computed for this file; staging reads the bytes again
/// and refuses to publish a name whose content no longer matches, so the
/// content address is always honest. The size cap is checked on the stat
/// first, so an oversize book is never read into memory.
pub fn stage_book_blob(root: &Path, source: &Path, hash: &str) -> Result<BookBlobStage, AppError> {
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| AppError::InvalidInput("book file has no extension".into()))?;
    let Some(name) = book_blob_name(&format!("{hash}.{extension}")) else {
        return Err(AppError::InvalidInput(format!(
            "invalid book blob name for {}",
            source.display()
        )));
    };
    if fs::metadata(source)?.len() > MAX_BOOK_BLOB_BYTES {
        return Ok(BookBlobStage::Oversize);
    }
    let destination = root.join(BOOK_BLOB_DIR).join(&name);
    if destination.exists() {
        return Ok(BookBlobStage::Stored);
    }
    let bytes = fs::read(source)?;
    if bytes.len() as u64 > MAX_BOOK_BLOB_BYTES {
        return Ok(BookBlobStage::Oversize);
    }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != hash {
        return Err(AppError::InvalidInput(format!(
            "book file changed between hash and staging: expected {hash}, found {actual}"
        )));
    }
    write_bytes_atomic(&destination, &bytes)?;
    Ok(BookBlobStage::Stored)
}

/// True when the sync folder carries a grammar-valid book blob. Consumers
/// still verify the SHA-256 on receipt; content addressing makes that free.
pub fn book_blob_exists(root: &Path, name: &str) -> bool {
    let Some(name) = book_blob_name(name) else {
        return false;
    };
    std::fs::metadata(root.join(BOOK_BLOB_DIR).join(name))
        .is_ok_and(|metadata| metadata.len() <= MAX_BOOK_BLOB_BYTES)
}
