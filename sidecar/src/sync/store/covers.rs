//! Cover blobs: content-addressed by the existing cache name
//! (`<16 hex>.<ext>`), copied between the local covers cache and the sync
//! folder.

use std::fs;
use std::path::Path;

use crate::error::AppError;

use super::io::write_bytes_atomic;
use super::COVER_BLOB_DIR;

/// The name is the only path component that crosses the sync boundary.
pub fn cover_file_name(path: &str) -> Option<String> {
    let name = Path::new(path).file_name()?.to_str()?;
    let (stem, extension) = name.rsplit_once('.')?;
    if !(8..=64).contains(&stem.len()) || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    if !matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "img") {
        return None;
    }
    Some(name.to_string())
}

pub fn store_cover_blob(root: &Path, covers_dir: &Path, file_name: &str) -> Result<(), AppError> {
    let Some(name) = cover_file_name(file_name) else {
        return Err(AppError::InvalidInput(format!(
            "invalid cover file name: {file_name}"
        )));
    };
    let source = covers_dir.join(&name);
    if !source.exists() {
        return Ok(());
    }
    let destination = root.join(COVER_BLOB_DIR).join(&name);
    if destination.exists() {
        return Ok(());
    }
    let bytes = fs::read(&source)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(AppError::InvalidInput(
            "cover image is larger than the 16 MiB sync limit".into(),
        ));
    }
    write_bytes_atomic(&destination, &bytes)
}

/// True when the sync folder carries a usable, content-addressed cover blob.
pub fn cover_blob_exists(root: &Path, file_name: &str) -> bool {
    let Some(name) = cover_file_name(file_name) else {
        return false;
    };
    std::fs::metadata(root.join(COVER_BLOB_DIR).join(name))
        .is_ok_and(|metadata| metadata.len() <= 16 * 1024 * 1024)
}

pub fn apply_cover_blob(root: &Path, covers_dir: &Path, file_name: &str) -> Result<bool, AppError> {
    let Some(name) = cover_file_name(file_name) else {
        return Ok(false);
    };
    let destination = covers_dir.join(&name);
    if destination.exists() {
        return Ok(true);
    }
    let source = root.join(COVER_BLOB_DIR).join(&name);
    if !source.exists() {
        return Ok(false);
    }
    let metadata = fs::metadata(&source)?;
    if metadata.len() > 16 * 1024 * 1024 {
        return Err(AppError::InvalidInput(
            "cover blob is larger than the 16 MiB sync limit".into(),
        ));
    }
    let bytes = fs::read(&source)?;
    fs::create_dir_all(covers_dir)?;
    write_bytes_atomic(&destination, &bytes)?;
    Ok(true)
}
