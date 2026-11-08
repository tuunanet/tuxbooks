//! JSON metadata reads and the temp-then-rename atomic writes.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub(super) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, AppError> {
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

pub(super) fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
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
