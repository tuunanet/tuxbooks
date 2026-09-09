use chrono::{DateTime, Utc};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// File format of a book, derived from the file extension. The scanner only
/// imports `.epub` today; `.pdf` exists so the rest of the system can already
/// be format-aware. Unrecognized extensions fall back to EPUB.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Epub,
    Pdf,
}

impl BookFormat {
    pub fn from_path(path: &str) -> Self {
        let extension = std::path::Path::new(path)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        match extension.as_deref() {
            Some("pdf") => BookFormat::Pdf,
            _ => BookFormat::Epub,
        }
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
    pub id: i64,
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
        let mut state = serializer.serialize_struct("Book", 23)?;
        state.serialize_field("id", &self.id)?;
        state.serialize_field("path", &self.path)?;
        state.serialize_field("format", &BookFormat::from_path(&self.path))?;
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
        assert!(json.get("lastOpenedAt").is_some());
        assert!(json.get("available").is_some());
        assert!(json.get("fileSize").is_some());
        assert!(json.get("fileMtime").is_some());
        assert!(json.get("added_at").is_none());
    }

    #[test]
    fn format_is_derived_from_file_extension() {
        assert_eq!(BookFormat::from_path("/tmp/a.epub"), BookFormat::Epub);
        assert_eq!(BookFormat::from_path("/tmp/a.EPUB"), BookFormat::Epub);
        assert_eq!(BookFormat::from_path("/tmp/b.pdf"), BookFormat::Pdf);
        assert_eq!(BookFormat::from_path("/tmp/b.PDF"), BookFormat::Pdf);
        assert_eq!(BookFormat::from_path("/tmp/no_extension"), BookFormat::Epub);
    }

    #[test]
    fn serialization_includes_derived_format() {
        let epub = serde_json::to_value(sample("/tmp/a.epub")).unwrap();
        assert_eq!(epub["format"], "epub");
        let pdf = serde_json::to_value(sample("/tmp/b.pdf")).unwrap();
        assert_eq!(pdf["format"], "pdf");
    }
}
