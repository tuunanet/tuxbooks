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
}

impl Serialize for Book {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("Book", 14)?;
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
        state.end()
    }
}

/// Data required to insert or update a book. `added_at`/`modified_at` are managed
/// by the database; `last_opened_at` is lifecycle state, not import data.
#[derive(Debug, Clone, PartialEq)]
pub struct NewBook {
    pub path: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub cover_path: Option<String>,
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
        }
    }

    #[test]
    fn book_serializes_with_camel_case_keys() {
        let json = serde_json::to_value(sample("/tmp/book.epub")).unwrap();
        assert!(json.get("addedAt").is_some());
        assert!(json.get("lastOpenedAt").is_some());
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
