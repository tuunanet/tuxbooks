use chrono::{DateTime, Utc};
use serde::Serialize;

/// A book as stored in the library database. Mirrors the `books` table.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
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

    #[test]
    fn book_serializes_with_camel_case_keys() {
        let book = Book {
            id: 1,
            path: "/tmp/book.epub".into(),
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
        };
        let json = serde_json::to_value(book).unwrap();
        assert!(json.get("addedAt").is_some());
        assert!(json.get("lastOpenedAt").is_some());
        assert!(json.get("added_at").is_none());
    }
}
