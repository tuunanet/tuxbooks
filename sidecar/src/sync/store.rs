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
    let named_tuxbooks = folder
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == SYNC_DIR_NAME);
    let root = if named_tuxbooks {
        folder.to_path_buf()
    } else {
        folder.join(SYNC_DIR_NAME)
    };
    fs::create_dir_all(&root)?;
    fs::canonicalize(&root).map_err(AppError::Io)
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
    let library = if library_path.exists() {
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
}
