//! Sync-root resolution, folder connect, and library archival.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;

use super::io::{read_json, write_json_atomic};
use super::{
    DeviceFile, FolderInfo, LibraryFile, COVER_BLOB_DIR, LIBRARY_FILE, MAX_LIBRARY_MARKER_BYTES,
    SYNC_DIR_NAME,
};
use crate::sync::model::{is_hex_id, OP_SCHEMA};

/// Resolve the sync root. A chosen folder that is already a TuxBooks sync
/// folder is used directly; anything else gets a `TuxBooks` child. That keeps
/// a Drive/Dropbox root clean and makes the folder self-describing.
pub fn resolve_root(folder: &Path) -> Result<PathBuf, AppError> {
    if !folder.is_absolute() {
        return Err(AppError::InvalidInput(
            "sync folder must be an absolute path".into(),
        ));
    }
    if !folder.is_dir() {
        return Err(AppError::InvalidInput(
            "sync folder is not available".into(),
        ));
    }
    let root = root_path(folder);
    fs::create_dir_all(&root)?;
    fs::canonicalize(&root).map_err(AppError::Io)
}

/// The TuxBooks child a chosen folder maps to, without touching the disk. A
/// folder already named `TuxBooks` is its own root.
fn root_path(folder: &Path) -> PathBuf {
    let named_tuxbooks = folder
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == SYNC_DIR_NAME);
    if named_tuxbooks {
        folder.to_path_buf()
    } else {
        folder.join(SYNC_DIR_NAME)
    }
}

/// Schema of the sync folder's library marker, or `None` when the folder is
/// not an absolute directory, or the marker is missing, unreadable, oversized,
/// or not a regular file. Diagnostics must never fail or create a folder just
/// because the sync folder went away.
pub fn library_schema(folder: &Path) -> Option<u32> {
    if !folder.is_absolute() || !folder.is_dir() {
        return None;
    }
    let path = root_path(folder).join(LIBRARY_FILE);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_LIBRARY_MARKER_BYTES {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    serde_json::from_slice::<LibraryFile>(&bytes)
        .ok()
        .map(|library| library.schema)
}

/// Move an existing sync library aside so the chosen folder can host a new
/// one. Returns the archived path, or `None` when the folder has no library
/// yet. Nothing is deleted; the old operation log and snapshots stay together
/// under a sibling name.
pub fn archive_existing_library(folder: &Path, stamp: &str) -> Result<Option<PathBuf>, AppError> {
    let root = resolve_root(folder)?;
    if !root.join(LIBRARY_FILE).exists() {
        return Ok(None);
    }
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(SYNC_DIR_NAME);
    let safe_stamp: String = stamp
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();
    let base = format!("{name}.before-{safe_stamp}");
    let mut target = root.with_file_name(&base);
    let mut suffix = 1;
    while target.exists() {
        target = root.with_file_name(format!("{base}-{suffix}"));
        suffix += 1;
    }
    fs::rename(&root, &target).map_err(AppError::Io)?;
    // The chosen folder can itself be the `TuxBooks` root. Recreate it so the
    // caller can immediately create the fresh library there.
    fs::create_dir_all(folder)?;
    Ok(Some(target))
}

pub fn connect(
    folder: &Path,
    device_id: &str,
    device_name: &str,
    now: &str,
) -> Result<FolderInfo, AppError> {
    let root = resolve_root(folder)?;
    probe_writable(&root)?;

    let library_path = root.join(LIBRARY_FILE);
    let existed = library_path.exists();
    let library = if existed {
        read_json::<LibraryFile>(&library_path)?
    } else {
        let library = LibraryFile {
            schema: OP_SCHEMA,
            library_id: random_library_id(),
            created_at: now.to_string(),
        };
        write_json_atomic(&library_path, &library)?;
        library
    };
    if library.schema > OP_SCHEMA {
        return Err(AppError::InvalidInput(format!(
            "sync folder uses schema {}, but this TuxBooks understands up to {}",
            library.schema, OP_SCHEMA
        )));
    }
    if !is_hex_id(&library.library_id) {
        return Err(AppError::InvalidInput(
            "sync folder has an invalid library id".into(),
        ));
    }

    let device_dir = root.join("devices").join(device_id);
    fs::create_dir_all(&device_dir)?;
    let device_path = device_dir.join("device.json");
    let device = if device_path.exists() {
        let mut device = read_json::<DeviceFile>(&device_path)?;
        if device.device_id != device_id {
            return Err(AppError::InvalidInput(
                "sync folder device file does not match this device".into(),
            ));
        }
        if device.name != device_name {
            device.name = device_name.to_string();
            write_json_atomic(&device_path, &device)?;
        }
        device
    } else {
        let device = DeviceFile {
            schema: OP_SCHEMA,
            device_id: device_id.to_string(),
            name: device_name.to_string(),
            created_at: now.to_string(),
        };
        write_json_atomic(&device_path, &device)?;
        device
    };

    fs::create_dir_all(root.join("ops").join(device_id))?;
    fs::create_dir_all(root.join(COVER_BLOB_DIR))?;
    Ok(FolderInfo {
        root,
        library,
        device,
        existed,
    })
}

fn probe_writable(root: &Path) -> Result<(), AppError> {
    let probe = root.join(format!(".tuxbooks-write-{}.tmp", std::process::id()));
    match fs::write(&probe, b"probe") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(err) => Err(AppError::InvalidInput(format!(
            "sync folder is not writable: {err}"
        ))),
    }
}

/// A 128-bit non-security identifier for a new sync folder. Database-backed
/// ids (device, book, op) use SQLite's `randomblob`; this one is needed before
/// a database row exists.
fn random_library_id() -> String {
    use std::hash::{Hash, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut first = std::collections::hash_map::DefaultHasher::new();
    (now, std::process::id(), sequence).hash(&mut first);
    let mut second = std::collections::hash_map::DefaultHasher::new();
    (
        now.rotate_left(17),
        std::process::id(),
        sequence,
        "tuxbooks",
    )
        .hash(&mut second);
    format!("{:016x}{:016x}", first.finish(), second.finish())
}
