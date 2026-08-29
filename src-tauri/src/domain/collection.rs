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
