use chrono::{DateTime, Utc};
use serde::ser::{Error as _, SerializeStruct};
use serde::{Serialize, Serializer};

/// File format of a book, derived from the file extension. Only formats the
/// library can import appear here; an unknown extension has no format instead
/// of being guessed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Epub,
    Pdf,
}

impl BookFormat {
    /// Extension → format. `None` means the library does not support the
    /// file, so callers decide whether to skip it or reject it. This is the
    /// single place that enumerates supported extensions.
    pub fn from_extension(extension: &std::ffi::OsStr) -> Option<Self> {
        match extension.to_str()?.to_ascii_lowercase().as_str() {
            "epub" => Some(BookFormat::Epub),
            "pdf" => Some(BookFormat::Pdf),
            _ => None,
        }
    }

    /// Path → format. `None` for a missing or unsupported extension.
    pub fn from_path(path: &str) -> Option<Self> {
        std::path::Path::new(path)
            .extension()
            .and_then(Self::from_extension)
    }
}

/// A book as stored in the library database. Mirrors the `books` table.
///
/// `Serialize` is implemented manually (instead of derived) so the IPC payload
/// can include `format`, which is derived from `path` and has no column.
///
/// The bibliographic columns are the *effective* metadata: user overrides
/// (milestone 7) merged over the source-file values. `series_name` is
/// resolved through the normalized `series` table by the repository queries.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Book {
    /// Public numeric identity: `book_records.id`, the durable book (ADR 0014).
    pub id: i64,
    /// Stable durable identity (ADR 0014). Several file rows can share it.
    pub book_uid: Option<String>,
    /// Internal file row this read resolved to, if the book currently has a
    /// file in the library. Reading state (progress, annotations, metadata,
    /// collections, last-opened) keys on the durable book, not this row.
    /// Never crosses the IPC boundary.
    #[sqlx(default)]
    pub file_id: Option<i64>,
    pub path: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub cover_path: Option<String>,
    pub added_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
    pub last_opened_at: Option<DateTime<Utc>>,
    /// Whether the source file still exists at `path`. Disappeared files keep
    /// the row (metadata, collections, progress) for reconnection.
    pub available: bool,
    /// Source file size in bytes at the last import/refresh.
    pub file_size: i64,
    /// Source file mtime as unix seconds at the last import/refresh.
    pub file_mtime: i64,
    /// Effective publication date (override or source).
    pub publication_date: Option<String>,
    /// Effective series membership, resolved through the `series` table.
    pub series_id: Option<i64>,
    pub series_index: Option<f64>,
    pub series_name: Option<String>,
    /// Coarse reading position (0..=100) from the `reading_progress` row,
    /// when the book has been opened. NULL = never read.
    pub progress_percent: Option<f64>,
    /// When the reading position was last saved; drives "In Progress" /
    /// "Finished" recency assumptions in the UI.
    pub progress_updated_at: Option<DateTime<Utc>>,
}

impl Serialize for Book {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("Book", 24)?;
        state.serialize_field("id", &self.id)?;
        state.serialize_field("bookUid", &self.book_uid)?;
        state.serialize_field("path", &self.path)?;
        // Stored rows carry a format the importer validated, so this never
        // fails for library data. Erroring instead of guessing keeps a future
        // format from being mislabeled as EPUB.
        let format = BookFormat::from_path(&self.path)
            .ok_or_else(|| S::Error::custom(format!("unrecognized book format: {}", self.path)))?;
        state.serialize_field("format", &format)?;
        state.serialize_field("title", &self.title)?;
        state.serialize_field("subtitle", &self.subtitle)?;
        state.serialize_field("author", &self.author)?;
        state.serialize_field("publisher", &self.publisher)?;
        state.serialize_field("language", &self.language)?;
        state.serialize_field("isbn", &self.isbn)?;
        state.serialize_field("description", &self.description)?;
        state.serialize_field("coverPath", &self.cover_path)?;
        state.serialize_field("addedAt", &self.added_at)?;
        state.serialize_field("modifiedAt", &self.modified_at)?;
        state.serialize_field("lastOpenedAt", &self.last_opened_at)?;
        state.serialize_field("available", &self.available)?;
        state.serialize_field("fileSize", &self.file_size)?;
        state.serialize_field("fileMtime", &self.file_mtime)?;
        state.serialize_field("publicationDate", &self.publication_date)?;
        state.serialize_field("seriesId", &self.series_id)?;
        state.serialize_field("seriesIndex", &self.series_index)?;
        state.serialize_field("seriesName", &self.series_name)?;
        state.serialize_field("progressPercent", &self.progress_percent)?;
        state.serialize_field("progressUpdatedAt", &self.progress_updated_at)?;
        state.end()
    }
}

/// One Reading-history row: a durable book with no file rows (ADR 0014 D6).
/// `id` is the durable book record id, so the row keeps a stable `bookId`
/// even when there is no file to read. Metadata comes from the durable
/// snapshot, while progress and annotation count are read from the state
/// tables so they stay current while the file is gone.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingHistoryBook {
    pub id: i64,
    pub book_uid: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover_path: Option<String>,
    pub progress_percent: Option<f64>,
    pub annotation_count: i64,
    pub last_opened_at: Option<DateTime<Utc>>,
    /// `available` when the durable snapshot has metadata, `waiting_for_file`
    /// for a record recovered from the sync mirror without one.
    pub metadata_state: String,
}

/// One library full-text search hit: the book's identity plus an FTS5
/// snippet taken from whichever indexed column matched best.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub book_id: i64,
    pub title: String,
    pub author: Option<String>,
    pub snippet: String,
}

/// Data required to insert or update a book. `added_at`/`modified_at` are managed
/// by the database; `last_opened_at` is lifecycle state, not import data.
/// File snapshots (`file_size`/`file_mtime`) come from the filesystem at parse
/// time; `available` is not import data (rows always import as available).
///
/// The bibliographic fields are the source-file truth: this struct is also
/// the payload the metadata service merges into `book_source_metadata`
/// (milestone 7), so user overrides survive re-imports.
#[derive(Debug, Clone, PartialEq)]
pub struct NewBook {
    pub path: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub authors: Vec<String>,
    pub subjects: Vec<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub publication_date: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub cover_path: Option<String>,
    pub file_size: i64,
    pub file_mtime: i64,
}

impl NewBook {
    /// Source metadata with the flat `author` display value folded into the
    /// author list (the EPUB parser keeps `author` as the first creator; the
    /// list is the normalized truth).
    pub fn author_list(&self) -> Vec<String> {
        if self.authors.is_empty() {
            return self.author.iter().cloned().collect();
        }
        self.authors.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(path: &str) -> Book {
        Book {
            id: 1,
            book_uid: Some("0123456789abcdef0123456789abcdef".into()),
            file_id: Some(1),
            path: path.into(),
            title: "T".into(),
            subtitle: None,
            author: None,
            publisher: None,
            language: None,
            isbn: None,
            description: None,
            cover_path: None,
            added_at: Utc::now(),
            modified_at: Utc::now(),
            last_opened_at: None,
            available: true,
            file_size: 0,
            file_mtime: 0,
            publication_date: None,
            series_id: None,
            series_index: None,
            series_name: None,
            progress_percent: None,
            progress_updated_at: None,
        }
    }

    #[test]
    fn book_serializes_with_camel_case_keys() {
        let json = serde_json::to_value(sample("/tmp/book.epub")).unwrap();
        assert!(json.get("addedAt").is_some());
        assert!(json.get("bookUid").is_some());
        assert!(json.get("lastOpenedAt").is_some());
        assert!(json.get("available").is_some());
        assert!(json.get("fileSize").is_some());
        assert!(json.get("fileMtime").is_some());
        assert!(json.get("added_at").is_none());
    }

    #[test]
    fn book_payload_carries_no_loose_field() {
        // The loose mechanism is retired (ADR 0008): no payload offers the
        // flag for future code to build on.
        let json = serde_json::to_value(sample("/tmp/book.epub")).unwrap();
        assert!(json.get("loose").is_none());
    }

    #[test]
    fn format_is_derived_from_file_extension() {
        assert_eq!(BookFormat::from_path("/tmp/a.epub"), Some(BookFormat::Epub));
        assert_eq!(BookFormat::from_path("/tmp/a.EPUB"), Some(BookFormat::Epub));
        assert_eq!(BookFormat::from_path("/tmp/b.pdf"), Some(BookFormat::Pdf));
        assert_eq!(BookFormat::from_path("/tmp/b.PDF"), Some(BookFormat::Pdf));
    }

    #[test]
    fn unsupported_extensions_have_no_format() {
        assert_eq!(BookFormat::from_path("/tmp/no_extension"), None);
        assert_eq!(BookFormat::from_path("/tmp/book.mobi"), None);
        assert_eq!(BookFormat::from_path("/tmp/archive.epub.zip"), None);
    }

    #[test]
    fn serialization_includes_derived_format() {
        let epub = serde_json::to_value(sample("/tmp/a.epub")).unwrap();
        assert_eq!(epub["format"], "epub");
        let pdf = serde_json::to_value(sample("/tmp/b.pdf")).unwrap();
        assert_eq!(pdf["format"], "pdf");
    }

    #[test]
    fn serialization_rejects_a_path_with_no_known_format() {
        // Stored rows always carry a supported extension. If one ever does
        // not, the payload fails instead of calling the book an EPUB.
        assert!(serde_json::to_value(sample("/tmp/book.mobi")).is_err());
    }
}
