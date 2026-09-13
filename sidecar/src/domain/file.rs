use serde::Serialize;

use super::BookFormat;

/// One native metadata entry read from a book file for the read-only
/// "Original File Metadata" panel. `key` is the file-format name (e.g.
/// "Creator", "Modification date"); the UI renders it as-is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProperty {
    pub key: String,
    pub value: String,
}

/// Read-only native properties of a book file, answered fresh from disk.
/// Never used for the effective library view; the source snapshot stays in
/// `book_source_metadata`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProperties {
    pub book_id: i64,
    pub format: BookFormat,
    pub entries: Vec<FileProperty>,
}
