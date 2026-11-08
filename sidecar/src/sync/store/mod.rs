//! The on-disk contract (docs/SYNC.md).
//!
//! The folder is untrusted, eventually consistent storage. Every operation is
//! immutable and written temp-then-rename, so a cloud client can copy files in
//! any order, duplicate them as a conflict copy, or deliver a partial temp
//! file without corrupting the local state.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

mod books;
mod covers;
mod io;
mod op_io;
mod root;
mod validate;

pub use books::{
    book_blob_exists, book_blob_name, stage_book_blob, BookBlobStage, BOOK_BLOB_DIR,
    MAX_BOOK_BLOB_BYTES,
};
pub use covers::{apply_cover_blob, cover_blob_exists, cover_file_name, store_cover_blob};
pub use io::write_json_atomic;
pub(crate) use op_io::is_op_file_name;
pub use op_io::{device_name, op_relative_path, read_op, scan_ops, write_op};
pub use root::{archive_existing_library, connect, library_schema, resolve_root};
pub use validate::{fields_object, validate_op};

#[cfg(test)]
mod tests;

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
