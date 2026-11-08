//! Operation files: paths, the flat-read scan, and the name rule the folder
//! watcher shares.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::AppError;

use super::io::write_bytes_atomic;
use super::validate::validate_op;
use super::{DeviceFile, RemoteFile};
use crate::sync::model::{is_safe_uid, Op, MAX_OP_FILE_BYTES};

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
            if !is_op_file_name(name) {
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

/// The flat-read op rule: a plain `*.json` name, never a dot-prefixed temp.
/// `store::scan_ops` and `engine::watcher` apply the same rule so the watcher
/// never wakes the engine for a file the pass would skip.
pub(crate) fn is_op_file_name(name: &str) -> bool {
    name.ends_with(".json") && !name.starts_with('.')
}

fn read_dirs(path: &Path) -> Result<Vec<std::path::PathBuf>, AppError> {
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
