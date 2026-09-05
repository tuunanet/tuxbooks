use chrono::{DateTime, Utc};
use serde::Serialize;

/// A user-defined grouping of books. Mirrors the `collections` table.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewCollection {
    pub name: String,
}

/// A collection plus the ids of its member books. The IPC shape behind
/// `list_collections`: one call feeds the sidebar (names), the collection
/// sections (membership filter), and the context menus (member checks).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    pub id: i64,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub book_ids: Vec<i64>,
}
