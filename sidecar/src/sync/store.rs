//! The on-disk contract (docs/SYNC.md).
//!
//! The folder is untrusted, eventually consistent storage. Every operation is
//! immutable and written temp-then-rename, so a cloud client can copy files in
//! any order, duplicate them as a conflict copy, or deliver a partial temp
//! file without corrupting the local state.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::AppError;

use super::model::{
    field_names, is_hex_hash, is_hex_id, is_safe_uid, EntityKind, Op, MAX_COLLECTION_NAME_BYTES,
    MAX_FIELD_STRING_BYTES, MAX_LIST_ITEMS, MAX_OP_FILE_BYTES, OP_SCHEMA,
};

pub const SYNC_DIR_NAME: &str = "TuxBooks";
const LIBRARY_FILE: &str = "library.json";
const COVER_BLOB_DIR: &str = "blobs/covers";
/// The marker is a three-field document. A much larger file is not a marker we
/// wrote, so diagnostics refuses to read it.
const MAX_LIBRARY_MARKER_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryFile {
    pub schema: u32,
    pub library_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceFile {
    pub schema: u32,
    pub device_id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct FolderInfo {
    pub root: PathBuf,
    pub library: LibraryFile,
    pub device: DeviceFile,
    /// True when `library.json` already existed. A freshly created library
    /// must not be mistaken for a different, established library.
    pub existed: bool,
}

#[derive(Debug, Clone)]
pub struct RemoteFile {
    pub relative_path: String,
    pub path: PathBuf,
    pub size: i64,
    pub mtime: i64,
}

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

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, AppError> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|err| AppError::InvalidInput(format!("cannot read {}: {err}", path.display())))
}

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sync");
    let temp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|err| AppError::InvalidInput(format!("cannot serialize sync metadata: {err}")))?;
    let write = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()
    })();
    if let Err(err) = write {
        let _ = fs::remove_file(&temp);
        return Err(AppError::Io(err));
    }
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(first) => {
            // Windows does not replace an existing destination on rename.
            if fs::remove_file(path).is_ok() && fs::rename(&temp, path).is_ok() {
                Ok(())
            } else {
                let _ = fs::remove_file(&temp);
                Err(AppError::Io(first))
            }
        }
    }
}

/// Display name for a device that wrote an operation. The folder is untrusted
/// and a device may never have written its file here, so a missing or
/// malformed `device.json` falls back to the id the operation carries. That
/// keeps conflict review readable without turning an unreadable folder into a
/// failure.
pub fn device_name(root: &Path, device_id: &str) -> String {
    if !is_safe_uid(device_id) {
        return device_id.to_string();
    }
    let path = root.join("devices").join(device_id).join("device.json");
    let name = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<DeviceFile>(&bytes).ok())
        .map(|device| device.name.trim().to_string())
        .filter(|name| !name.is_empty());
    name.unwrap_or_else(|| device_id.to_string())
}

pub fn op_relative_path(op: &Op) -> String {
    format!(
        "ops/{}/{:020}-{:06}-{}.json",
        op.device_id, op.hlc.wall, op.hlc.counter, op.op_id
    )
}

pub fn write_op(root: &Path, op: &Op) -> Result<String, AppError> {
    let relative = op_relative_path(op);
    let path = root.join(&relative);
    let bytes = serde_json::to_vec(op)
        .map_err(|err| AppError::InvalidInput(format!("cannot serialize sync op: {err}")))?;
    if bytes.len() as u64 > MAX_OP_FILE_BYTES {
        return Err(AppError::InvalidInput(
            "sync operation is larger than the 1 MiB limit".into(),
        ));
    }
    write_bytes_atomic(&path, &bytes)?;
    Ok(relative)
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("op");
    let temp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    let write = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(err) = write {
        let _ = fs::remove_file(&temp);
        return Err(AppError::Io(err));
    }
    if let Err(err) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(AppError::Io(err));
    }
    Ok(())
}

pub fn read_op(path: &Path) -> Result<Op, String> {
    let metadata = fs::metadata(path).map_err(|err| format!("cannot stat: {err}"))?;
    if metadata.len() > MAX_OP_FILE_BYTES {
        return Err(format!(
            "operation is {} bytes, over the 1 MiB limit",
            metadata.len()
        ));
    }
    let bytes = fs::read(path).map_err(|err| format!("cannot read: {err}"))?;
    let op: Op = serde_json::from_slice(&bytes).map_err(|err| format!("invalid JSON: {err}"))?;
    validate_op(&op)?;
    Ok(op)
}

pub fn scan_ops(root: &Path) -> Result<Vec<RemoteFile>, AppError> {
    let ops_root = root.join("ops");
    if !ops_root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for device in read_dirs(&ops_root)? {
        for entry in fs::read_dir(&device)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if !file_type.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.ends_with(".json") || name.starts_with('.') {
                continue;
            }
            let metadata = entry.metadata()?;
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or(0);
            let device_name = device
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            files.push(RemoteFile {
                relative_path: format!("ops/{device_name}/{name}"),
                path: entry.path(),
                size: metadata.len() as i64,
                mtime,
            });
        }
    }
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

fn read_dirs(path: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut dirs = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            dirs.push(entry.path());
        }
    }
    dirs.sort();
    Ok(dirs)
}

/// Covers are content-addressed by the existing cache name
/// (`<16 hex>.<ext>`). The name is the only path component that crosses the
/// sync boundary.
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

pub fn validate_op(op: &Op) -> Result<(), String> {
    if op.schema != OP_SCHEMA {
        return Err(format!("unsupported operation schema {}", op.schema));
    }
    if !is_hex_id(&op.op_id) {
        return Err("op_id must be 32 lowercase hex characters".into());
    }
    if !is_hex_id(&op.device_id) {
        return Err("device_id must be 32 lowercase hex characters".into());
    }
    if op.hlc.device != op.device_id {
        return Err("hlc device must match device_id".into());
    }
    if op.hlc.wall < 0 {
        return Err("hlc wall must not be negative".into());
    }
    if !is_safe_uid(&op.entity_uid) {
        return Err("entity_uid contains unsupported characters".into());
    }
    if let Some(book_uid) = &op.book_uid {
        if !is_safe_uid(book_uid) {
            return Err("book_uid contains unsupported characters".into());
        }
    }
    if op.deleted && !op.fields.is_empty() {
        return Err("a delete operation carries prior state, not fields".into());
    }
    if op.restore && op.deleted {
        return Err("a restore cannot also be a delete".into());
    }
    if op.kind == EntityKind::BookIdentity {
        if op.deleted {
            return Err("book identity operations cannot be deletes".into());
        }
        if op.book_uid.as_deref() != Some(op.entity_uid.as_str()) {
            return Err("book identity entity_uid must equal book_uid".into());
        }
    } else if op.kind == EntityKind::Book {
        if op.book_uid.as_deref() != Some(op.entity_uid.as_str()) {
            return Err("book entity_uid must equal book_uid".into());
        }
    } else if op.kind != EntityKind::Collection
        && op.kind != EntityKind::BookIdentity
        && op.book_uid.is_none()
    {
        return Err("book-scoped operation is missing book_uid".into());
    }
    let allowed = field_names(op.kind);
    for (field, value) in &op.fields {
        if !allowed.contains(&field.as_str()) {
            return Err(format!(
                "field {field} is not valid for {}",
                op.kind.as_str()
            ));
        }
        validate_field_value(op.kind, field, value)?;
    }
    if let Some(prior) = &op.prior {
        for (field, value) in prior {
            if !allowed.contains(&field.as_str()) {
                return Err(format!(
                    "prior field {field} is not valid for {}",
                    op.kind.as_str()
                ));
            }
            validate_field_value(op.kind, field, value)?;
        }
    }
    if op.kind == EntityKind::Membership {
        // The entity uid is `<collection_uid>:<book_uid>`; both need to be
        // present and safe. The book uid is also checked above.
        let parts: Vec<&str> = op.entity_uid.split(':').collect();
        if parts.len() != 2 || !is_safe_uid(parts[0]) || !is_safe_uid(parts[1]) {
            return Err("membership entity_uid must be collection:book".into());
        }
    }
    Ok(())
}

fn validate_field_value(kind: EntityKind, field: &str, value: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    match (kind, field) {
        (EntityKind::Annotation, "kind") => match value.as_str() {
            Some("bookmark") | Some("highlight") => Ok(()),
            _ => Err("annotation kind must be bookmark or highlight".into()),
        },
        (EntityKind::Annotation, "page_number") => positive_integer(value, field),
        (EntityKind::Annotation, "page_fraction") => unit_number(value, field),
        (EntityKind::Annotation, _) => bounded_string(value, field),
        (EntityKind::Progress, "progress_percent") => percent(value),
        (EntityKind::Progress, "progression") => unit_number(value, field),
        (EntityKind::Progress, "character_offset") => non_negative_integer(value, field),
        (EntityKind::Progress, "page_number") => positive_integer(value, field),
        (EntityKind::Progress, "scroll_offset") => number(value, field),
        (EntityKind::Progress, "schema_version") => non_negative_integer(value, field),
        (EntityKind::Progress, _) => bounded_string(value, field),
        (EntityKind::Metadata, "series_index") => number(value, field),
        (EntityKind::Metadata, "authors_customized")
        | (EntityKind::Metadata, "subjects_customized") => match value.as_bool() {
            Some(_) => Ok(()),
            None => Err(format!("{field} must be a boolean")),
        },
        (EntityKind::Metadata, "authors") | (EntityKind::Metadata, "subjects") => {
            string_list(value, field)
        }
        (EntityKind::Metadata, _) => bounded_string(value, field),
        (EntityKind::Collection, "name") => {
            let name = value
                .as_str()
                .ok_or_else(|| "collection name must be a string".to_string())?;
            if name.trim().is_empty() {
                return Err("collection name is empty".into());
            }
            if name.len() > MAX_COLLECTION_NAME_BYTES {
                return Err("collection name is too long".into());
            }
            Ok(())
        }
        (EntityKind::Collection, _) => bounded_string(value, field),
        (EntityKind::Membership, "present") => match value.as_bool() {
            Some(_) => Ok(()),
            None => Err("membership present must be a boolean".into()),
        },
        (EntityKind::Membership, _) => bounded_string(value, field),
        (EntityKind::Opened, _) => bounded_string(value, field),
        (EntityKind::BookIdentity, "content_hash") => match value.as_str() {
            Some(hash) if is_hex_hash(hash) => Ok(()),
            _ => Err("content_hash must be 64 lowercase hex characters".into()),
        },
        (EntityKind::BookIdentity, _) => Err(format!("unknown identity field {field}")),
        (EntityKind::Book, "snapshot") => bounded_string(value, field),
        (EntityKind::Book, "replacement_book_uid") => match value.as_str() {
            Some(uid) if is_safe_uid(uid) => Ok(()),
            _ => Err("replacement_book_uid must be a safe uid".into()),
        },
        (EntityKind::Book, "discarded") => match value.as_bool() {
            Some(_) => Ok(()),
            None => Err("discarded must be a boolean".into()),
        },
        (EntityKind::Book, _) => Err(format!("unknown book field {field}")),
    }
}

fn bounded_string(value: &Value, field: &str) -> Result<(), String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a string or null"))?;
    if text.len() > MAX_FIELD_STRING_BYTES {
        return Err(format!("{field} is too long"));
    }
    Ok(())
}

fn string_list(value: &Value, field: &str) -> Result<(), String> {
    let items = value
        .as_array()
        .ok_or_else(|| format!("{field} must be an array or null"))?;
    if items.len() > MAX_LIST_ITEMS {
        return Err(format!("{field} has too many entries"));
    }
    for item in items {
        let text = item
            .as_str()
            .ok_or_else(|| format!("{field} entries must be strings"))?;
        if text.len() > 1024 {
            return Err(format!("{field} entry is too long"));
        }
    }
    Ok(())
}

fn positive_integer(value: &Value, field: &str) -> Result<(), String> {
    let number = value
        .as_i64()
        .ok_or_else(|| format!("{field} must be an integer"))?;
    if number < 1 {
        return Err(format!("{field} must be at least 1"));
    }
    Ok(())
}

fn non_negative_integer(value: &Value, field: &str) -> Result<(), String> {
    let number = value
        .as_i64()
        .ok_or_else(|| format!("{field} must be an integer"))?;
    if number < 0 {
        return Err(format!("{field} must not be negative"));
    }
    Ok(())
}

fn number(value: &Value, field: &str) -> Result<(), String> {
    if value.as_f64().is_none() {
        return Err(format!("{field} must be a number"));
    }
    Ok(())
}

fn unit_number(value: &Value, field: &str) -> Result<(), String> {
    let number = value
        .as_f64()
        .ok_or_else(|| format!("{field} must be a number"))?;
    if !(0.0..=1.0).contains(&number) {
        return Err(format!("{field} is outside 0..=1"));
    }
    Ok(())
}

fn percent(value: &Value) -> Result<(), String> {
    let number = value
        .as_f64()
        .ok_or_else(|| "progress_percent must be a number".to_string())?;
    if !(0.0..=100.0).contains(&number) {
        return Err("progress_percent is outside 0..=100".into());
    }
    Ok(())
}

/// The `fields` map is serialized as part of an op; this helper keeps the
/// caller from accidentally sending a non-object.
pub fn fields_object(value: Value) -> Result<Map<String, Value>, String> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "fields must be an object".to_string())
}

#[cfg(test)]
mod tests {
    use super::super::model::Hlc;
    use super::*;
    use serde_json::json;

    fn op(kind: EntityKind, fields: Value) -> Op {
        Op {
            schema: OP_SCHEMA,
            op_id: "a".repeat(32),
            device_id: "b".repeat(32),
            hlc: Hlc {
                wall: 1,
                counter: 0,
                device: "b".repeat(32),
            },
            kind,
            entity_uid: "e".repeat(32),
            book_uid: Some("e".repeat(32)),
            deleted: false,
            restore: false,
            fields: fields_object(fields).unwrap(),
            prior: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn valid_annotation_op_passes() {
        validate_op(&op(
            EntityKind::Annotation,
            json!({"kind": "highlight", "text": "passage", "note": null}),
        ))
        .unwrap();
    }

    #[test]
    fn rejects_unknown_fields_and_bad_types() {
        assert!(validate_op(&op(
            EntityKind::Annotation,
            json!({"kind": "highlight", "evil": "x"})
        ))
        .is_err());
        assert!(validate_op(&op(
            EntityKind::Annotation,
            json!({"kind": "highlight", "page_number": 0})
        ))
        .is_err());
        assert!(validate_op(&op(EntityKind::Membership, json!({"present": "yes"}))).is_err());
        assert!(validate_op(&op(
            EntityKind::BookIdentity,
            json!({"content_hash": "a".repeat(64), "evil": "x"})
        ))
        .is_err());
        assert!(validate_op(&op(
            EntityKind::Book,
            json!({"snapshot": null, "evil": "x"})
        ))
        .is_err());
    }

    #[test]
    fn archiving_a_folder_without_a_library_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        assert!(archive_existing_library(&folder, "2026-10-29T15:01:00Z")
            .unwrap()
            .is_none());
    }

    #[test]
    fn cover_names_reject_traversal() {
        assert!(cover_file_name("/x/covers/0123456789abcdef.png").is_some());
        assert!(cover_file_name("../../etc/passwd").is_none());
        assert!(cover_file_name("/x/covers/not-a-cover.png").is_none());
    }

    #[test]
    fn root_adds_tuxbooks_child_once() {
        let tmp = tempfile::tempdir().unwrap();
        let root = resolve_root(tmp.path()).unwrap();
        assert_eq!(root.file_name().unwrap(), SYNC_DIR_NAME);
        let again = resolve_root(&root).unwrap();
        assert_eq!(again, root);
    }

    #[test]
    fn connect_reports_whether_it_created_the_library() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();

        let first = connect(&folder, "device", "Laptop", "2026-10-29T15:00:00Z").unwrap();
        assert!(!first.existed, "the first connect creates the library");

        let second = connect(&folder, "device", "Laptop", "2026-10-29T15:00:01Z").unwrap();
        assert!(second.existed, "the second connect finds the same library");
        assert_eq!(first.library.library_id, second.library.library_id);
    }

    #[test]
    fn archive_moves_an_existing_library_aside_and_keeps_its_files() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        let first = connect(&folder, "device", "Laptop", "2026-10-29T15:00:00Z").unwrap();
        let old_id = first.library.library_id.clone();

        let archived = archive_existing_library(&folder, "2026-10-29T15:01:00Z")
            .unwrap()
            .expect("an existing library was archived");
        assert!(archived.join(LIBRARY_FILE).exists());
        assert!(archived
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("TuxBooks.before-"));

        let next = connect(&folder, "device", "Laptop", "2026-10-29T15:01:01Z").unwrap();
        assert!(!next.existed);
        assert_ne!(next.library.library_id, old_id);
    }

    #[test]
    fn archiving_a_folder_named_tuxbooks_recreates_the_chosen_path() {
        let tmp = tempfile::tempdir().unwrap();
        let chosen = tmp.path().join("TuxBooks");
        fs::create_dir_all(&chosen).unwrap();
        connect(&chosen, "device", "Laptop", "2026-10-29T15:00:00Z").unwrap();
        let old_id = connect(&chosen, "device", "Laptop", "2026-10-29T15:00:01Z")
            .unwrap()
            .library
            .library_id;

        let archived = archive_existing_library(&chosen, "2026-10-29T15:02:00Z")
            .unwrap()
            .expect("library archived");
        assert!(
            chosen.is_dir(),
            "the chosen path is ready for a new library"
        );
        let next = connect(&chosen, "device", "Laptop", "2026-10-29T15:02:01Z").unwrap();
        assert!(!next.existed);
        assert_ne!(next.library.library_id, old_id);
        assert!(archived.join(LIBRARY_FILE).exists());
    }

    #[test]
    fn writes_and_reads_an_op() {
        let tmp = tempfile::tempdir().unwrap();
        let root = resolve_root(tmp.path()).unwrap();
        let op = op(
            EntityKind::Annotation,
            json!({"kind": "bookmark", "cfi": "x"}),
        );
        let relative = write_op(&root, &op).unwrap();
        let read = read_op(&root.join(relative)).unwrap();
        assert_eq!(read.op_id, op.op_id);
        assert_eq!(read.kind, EntityKind::Annotation);
    }

    #[test]
    fn resolve_root_rejects_relative_and_missing_paths() {
        assert!(resolve_root(Path::new("relative/path")).is_err());
        let tmp = tempfile::tempdir().unwrap();
        assert!(resolve_root(&tmp.path().join("missing")).is_err());
    }

    #[test]
    fn library_schema_is_bounded_and_requires_a_regular_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();

        assert!(library_schema(Path::new("relative/path")).is_none());
        assert!(library_schema(&tmp.path().join("missing")).is_none());
        assert!(library_schema(&folder).is_none(), "no marker yet");

        let root = resolve_root(&folder).unwrap();
        write_json_atomic(
            &root.join(LIBRARY_FILE),
            &json!({
                "schema": OP_SCHEMA,
                "library_id": "a".repeat(32),
                "created_at": "2026-10-29T00:00:00.000Z",
            }),
        )
        .unwrap();
        assert_eq!(library_schema(&folder), Some(OP_SCHEMA));
        // A folder already named TuxBooks is its own root.
        assert_eq!(library_schema(&root), Some(OP_SCHEMA));

        fs::write(root.join(LIBRARY_FILE), b"{not json").unwrap();
        assert!(library_schema(&folder).is_none(), "invalid JSON");

        fs::write(
            root.join(LIBRARY_FILE),
            vec![b' '; MAX_LIBRARY_MARKER_BYTES as usize + 1],
        )
        .unwrap();
        assert!(library_schema(&folder).is_none(), "oversized");

        fs::remove_file(root.join(LIBRARY_FILE)).unwrap();
        fs::create_dir(root.join(LIBRARY_FILE)).unwrap();
        assert!(library_schema(&folder).is_none(), "not a regular file");
    }

    #[test]
    fn connect_rejects_newer_schemas_and_invalid_library_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        let root = resolve_root(&folder).unwrap();
        write_json_atomic(
            &root.join(LIBRARY_FILE),
            &json!({
                "schema": OP_SCHEMA + 1,
                "library_id": "a".repeat(32),
                "created_at": "2026-10-29T00:00:00.000Z",
            }),
        )
        .unwrap();
        let newer = connect(&folder, "device", "Laptop", "now").unwrap_err();
        assert!(newer.to_string().contains("schema"), "{newer}");

        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        let root = resolve_root(&folder).unwrap();
        write_json_atomic(
            &root.join(LIBRARY_FILE),
            &json!({
                "schema": OP_SCHEMA,
                "library_id": "not-a-library-id",
                "created_at": "2026-10-29T00:00:00.000Z",
            }),
        )
        .unwrap();
        let invalid = connect(&folder, "device", "Laptop", "now").unwrap_err();
        assert!(
            invalid.to_string().contains("invalid library id"),
            "{invalid}"
        );
    }

    #[test]
    fn connect_updates_a_renamed_device_and_rejects_a_foreign_device_file() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        let first = connect(&folder, "device", "Laptop", "2026-10-29T15:00:00Z").unwrap();
        let second = connect(&folder, "device", "Desktop", "2026-10-29T15:00:01Z").unwrap();
        assert_eq!(second.device.name, "Desktop");
        assert_eq!(first.library.library_id, second.library.library_id);

        let device_path = second.root.join("devices/device/device.json");
        let mut foreign: DeviceFile = read_json(&device_path).unwrap();
        foreign.device_id = "another-device".into();
        write_json_atomic(&device_path, &foreign).unwrap();
        let err = connect(&folder, "device", "Desktop", "2026-10-29T15:00:02Z").unwrap_err();
        assert!(err.to_string().contains("does not match"), "{err}");
    }

    #[test]
    fn archive_uses_a_suffixed_name_when_the_first_target_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("sync");
        fs::create_dir_all(&folder).unwrap();
        connect(&folder, "device", "Laptop", "2026-10-29T15:00:00Z").unwrap();

        let stamp = "2026-10-29T15:01:00Z";
        let first_target = folder.join("TuxBooks.before-20261029T150100Z");
        fs::create_dir_all(&first_target).unwrap();

        let archived = archive_existing_library(&folder, stamp).unwrap().unwrap();
        assert_eq!(archived, folder.join("TuxBooks.before-20261029T150100Z-1"));
        assert!(archived.join(LIBRARY_FILE).exists());
    }

    #[test]
    fn scan_ops_ignores_non_operation_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = resolve_root(tmp.path()).unwrap();
        assert!(scan_ops(&root).unwrap().is_empty());

        let op = op(
            EntityKind::Annotation,
            json!({"kind": "bookmark", "cfi": "x"}),
        );
        let relative = write_op(&root, &op).unwrap();
        let device_dir = root.join("ops").join(&op.device_id);
        fs::write(device_dir.join("notes.txt"), b"not an op").unwrap();
        fs::write(device_dir.join(".hidden.json"), b"{}").unwrap();
        fs::create_dir_all(device_dir.join("nested.json")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let non_utf8 = std::ffi::OsString::from_vec(b"bad\xff.json".to_vec());
            fs::write(device_dir.join(non_utf8), b"{}").unwrap();
        }

        let files = scan_ops(&root).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative_path, relative);
        assert!(files[0].size > 0);
    }

    #[test]
    fn read_op_rejects_oversized_malformed_and_invalid_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = resolve_root(tmp.path()).unwrap();

        assert!(read_op(&root.join("missing.json"))
            .unwrap_err()
            .contains("cannot stat"));

        let oversized = root.join("oversized.json");
        fs::write(&oversized, vec![b' '; MAX_OP_FILE_BYTES as usize + 1]).unwrap();
        assert!(read_op(&oversized)
            .unwrap_err()
            .contains("over the 1 MiB limit"));

        let malformed = root.join("malformed.json");
        fs::write(&malformed, b"{not json").unwrap();
        assert!(read_op(&malformed).unwrap_err().contains("invalid JSON"));

        let mut invalid = op(EntityKind::Annotation, json!({"kind": "bookmark"}));
        invalid.op_id = "short".into();
        let invalid_path = root.join("invalid.json");
        fs::write(&invalid_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(read_op(&invalid_path).unwrap_err().contains("op_id"));
    }

    #[test]
    fn write_op_rejects_operations_over_the_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = resolve_root(tmp.path()).unwrap();
        let oversized = op(
            EntityKind::Annotation,
            json!({"kind": "bookmark", "note": "x".repeat(1_100_000)}),
        );
        let err = write_op(&root, &oversized).unwrap_err();
        assert!(err.to_string().contains("1 MiB"), "{err}");
    }

    #[test]
    fn cover_blob_storage_round_trips_and_rejects_bad_input() {
        let tmp = tempfile::tempdir().unwrap();
        let root = resolve_root(tmp.path()).unwrap();
        let covers = tmp.path().join("covers");
        let name = "0123456789abcdef.png";

        assert!(store_cover_blob(&root, &covers, "../../etc/passwd").is_err());
        store_cover_blob(&root, &covers, name).unwrap();
        assert!(!root.join(COVER_BLOB_DIR).join(name).exists());

        fs::create_dir_all(&covers).unwrap();
        fs::write(covers.join(name), b"cover-bytes").unwrap();
        store_cover_blob(&root, &covers, name).unwrap();
        assert_eq!(
            fs::read(root.join(COVER_BLOB_DIR).join(name)).unwrap(),
            b"cover-bytes"
        );
        // An already stored blob is left alone.
        store_cover_blob(&root, &covers, name).unwrap();

        let oversized = "fedcba9876543210.png";
        let file = fs::File::create(covers.join(oversized)).unwrap();
        file.set_len(16 * 1024 * 1024 + 1).unwrap();
        let err = store_cover_blob(&root, &covers, oversized).unwrap_err();
        assert!(err.to_string().contains("16 MiB"), "{err}");
    }

    #[test]
    fn apply_cover_blob_handles_existing_missing_and_oversized_blobs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = resolve_root(tmp.path()).unwrap();
        let covers = tmp.path().join("covers");
        let name = "0123456789abcdef.png";

        assert!(!apply_cover_blob(&root, &covers, "../../etc/passwd").unwrap());
        assert!(!apply_cover_blob(&root, &covers, name).unwrap());

        let blob_dir = root.join(COVER_BLOB_DIR);
        fs::create_dir_all(&blob_dir).unwrap();
        fs::write(blob_dir.join(name), b"blob").unwrap();
        assert!(apply_cover_blob(&root, &covers, name).unwrap());
        assert_eq!(fs::read(covers.join(name)).unwrap(), b"blob");
        // An already cached cover is not copied again.
        assert!(apply_cover_blob(&root, &covers, name).unwrap());

        let oversized = "fedcba9876543210.png";
        let file = fs::File::create(blob_dir.join(oversized)).unwrap();
        file.set_len(16 * 1024 * 1024 + 1).unwrap();
        let err = apply_cover_blob(&root, &covers, oversized).unwrap_err();
        assert!(err.to_string().contains("16 MiB"), "{err}");
    }

    #[test]
    fn validate_op_rejects_malformed_envelopes() {
        let base = op(
            EntityKind::Annotation,
            json!({"kind": "bookmark", "cfi": "x"}),
        );

        let mut bad = base.clone();
        bad.schema = OP_SCHEMA + 1;
        assert_op_rejected(&bad, "a newer schema");

        let mut bad = base.clone();
        bad.op_id = "short".into();
        assert_op_rejected(&bad, "a malformed op id");

        let mut bad = base.clone();
        bad.device_id = "short".into();
        assert_op_rejected(&bad, "a malformed device id");

        let mut bad = base.clone();
        bad.hlc.device = "c".repeat(32);
        assert_op_rejected(&bad, "an hlc device that differs from the device id");

        let mut bad = base.clone();
        bad.hlc.wall = -1;
        assert_op_rejected(&bad, "a negative hlc wall");

        let mut bad = base.clone();
        bad.entity_uid = "../escape".into();
        assert_op_rejected(&bad, "an unsafe entity uid");

        let mut bad = base.clone();
        bad.book_uid = Some("../escape".into());
        assert_op_rejected(&bad, "an unsafe book uid");

        let mut bad = base.clone();
        bad.deleted = true;
        assert_op_rejected(&bad, "a delete that carries fields");

        let mut bad = base.clone();
        bad.fields.clear();
        bad.deleted = true;
        bad.restore = true;
        assert_op_rejected(&bad, "a restore that is also a delete");

        let mut bad = op(
            EntityKind::BookIdentity,
            json!({"content_hash": "a".repeat(64)}),
        );
        bad.deleted = true;
        bad.fields.clear();
        assert_op_rejected(&bad, "a book identity delete");

        let mut bad = op(
            EntityKind::BookIdentity,
            json!({"content_hash": "a".repeat(64)}),
        );
        bad.book_uid = Some("f".repeat(32));
        assert_op_rejected(&bad, "a book identity whose uid differs");

        let mut bad = op(EntityKind::Book, json!({"snapshot": "{}"}));
        bad.book_uid = Some("f".repeat(32));
        assert_op_rejected(&bad, "a book whose uid differs");

        let mut bad = op(EntityKind::Progress, json!({"progress_percent": 1.0}));
        bad.book_uid = None;
        assert_op_rejected(&bad, "a book-scoped progress op without a book");

        let mut bad = op(EntityKind::Metadata, json!({"title": "Book"}));
        bad.book_uid = None;
        assert_op_rejected(&bad, "a book-scoped metadata op without a book");

        let mut bad = base.clone();
        bad.prior = json!({"evil": "x"}).as_object().cloned();
        assert_op_rejected(&bad, "an unknown prior field");

        let mut bad = base.clone();
        bad.prior = json!({"page_number": 0}).as_object().cloned();
        assert_op_rejected(&bad, "an invalid prior value");

        let mut membership = op(EntityKind::Membership, json!({"present": true}));
        membership.entity_uid = "collection-only".into();
        assert_op_rejected(&membership, "a membership uid without a book part");

        let mut collection = op(EntityKind::Collection, json!({"name": "Shelf"}));
        collection.book_uid = None;
        validate_op(&collection).unwrap();

        let mut identity = op(
            EntityKind::BookIdentity,
            json!({"content_hash": "a".repeat(64)}),
        );
        identity.book_uid = Some(identity.entity_uid.clone());
        validate_op(&identity).unwrap();
    }

    fn assert_op_rejected(op: &Op, because: &str) {
        assert!(validate_op(op).is_err(), "expected rejection for {because}");
    }

    fn assert_field_rejected(kind: EntityKind, fields: Value) {
        assert!(
            validate_op(&op(kind, fields)).is_err(),
            "expected {kind:?} fields to be rejected"
        );
    }

    fn assert_field_accepted(kind: EntityKind, fields: Value) {
        validate_op(&op(kind, fields)).unwrap();
    }

    #[test]
    fn validate_field_values_rejects_bad_types_and_ranges() {
        assert_field_rejected(EntityKind::Annotation, json!({"kind": "note"}));
        assert_field_rejected(
            EntityKind::Annotation,
            json!({"kind": "bookmark", "page_number": 0}),
        );
        assert_field_rejected(
            EntityKind::Annotation,
            json!({"kind": "bookmark", "page_fraction": 1.5}),
        );
        assert_field_rejected(
            EntityKind::Annotation,
            json!({"kind": "bookmark", "text": "x".repeat(MAX_FIELD_STRING_BYTES + 1)}),
        );
        assert_field_rejected(
            EntityKind::Annotation,
            json!({"kind": "bookmark", "text": 5}),
        );
        assert_field_accepted(
            EntityKind::Annotation,
            json!({"kind": "bookmark", "page_fraction": 0.5, "text": null}),
        );

        assert_field_rejected(EntityKind::Progress, json!({"progress_percent": 101.0}));
        assert_field_rejected(EntityKind::Progress, json!({"progress_percent": "x"}));
        assert_field_rejected(EntityKind::Progress, json!({"progression": -0.1}));
        assert_field_rejected(EntityKind::Progress, json!({"character_offset": -1}));
        assert_field_rejected(EntityKind::Progress, json!({"character_offset": "x"}));
        assert_field_rejected(EntityKind::Progress, json!({"page_number": 0}));
        assert_field_rejected(EntityKind::Progress, json!({"scroll_offset": "x"}));
        assert_field_rejected(EntityKind::Progress, json!({"schema_version": -1}));
        assert_field_accepted(
            EntityKind::Progress,
            json!({"progress_percent": 50.0, "progression": 1.0, "character_offset": 0}),
        );

        assert_field_rejected(EntityKind::Metadata, json!({"series_index": "x"}));
        assert_field_rejected(EntityKind::Metadata, json!({"authors_customized": "yes"}));
        assert_field_rejected(EntityKind::Metadata, json!({"authors": "not-an-array"}));
        assert_field_rejected(EntityKind::Metadata, json!({"authors": [1]}));
        assert_field_rejected(
            EntityKind::Metadata,
            json!({"authors": vec!["x"; MAX_LIST_ITEMS + 1]}),
        );
        assert_field_rejected(EntityKind::Metadata, json!({"authors": ["x".repeat(1025)]}));
        assert_field_accepted(
            EntityKind::Metadata,
            json!({"authors": ["Alice"], "subjects": ["Essays"], "series_index": 1.5}),
        );

        assert_field_rejected(EntityKind::Collection, json!({"name": ""}));
        assert_field_rejected(EntityKind::Collection, json!({"name": "   "}));
        assert_field_rejected(
            EntityKind::Collection,
            json!({"name": "x".repeat(MAX_COLLECTION_NAME_BYTES + 1)}),
        );
        assert_field_rejected(EntityKind::Collection, json!({"name": 5}));

        assert_field_rejected(EntityKind::Membership, json!({"present": "yes"}));
        assert_field_rejected(EntityKind::Membership, json!({"added_at": 5}));
        assert_field_rejected(EntityKind::Opened, json!({"last_opened_at": 5}));

        assert_field_rejected(EntityKind::BookIdentity, json!({"content_hash": "short"}));
        assert_field_rejected(EntityKind::BookIdentity, json!({"unknown": "x"}));

        assert_field_rejected(EntityKind::Book, json!({"snapshot": 5}));
        assert_field_rejected(
            EntityKind::Book,
            json!({"replacement_book_uid": "../escape"}),
        );
        assert_field_rejected(EntityKind::Book, json!({"discarded": "yes"}));
        assert_field_rejected(EntityKind::Book, json!({"unknown": "x"}));
    }

    #[test]
    fn fields_object_requires_an_object() {
        assert!(fields_object(json!({"note": "x"})).is_ok());
        assert!(fields_object(json!(["not", "an", "object"])).is_err());
        assert!(fields_object(Value::Null).is_err());
    }
}
