use chrono::{DateTime, Utc};
use serde::Serialize;

/// Where the user stopped reading a given book. Mirrors the `reading_progress` table.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingProgress {
    pub book_id: i64,
    pub chapter_href: Option<String>,
    pub character_offset: Option<i64>,
    pub progress_percent: Option<f64>,
    pub updated_at: DateTime<Utc>,
}

/// Writable subset of [`ReadingProgress`]. `book_id` is passed separately.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProgressUpdate {
    pub chapter_href: Option<String>,
    pub character_offset: Option<i64>,
    pub progress_percent: Option<f64>,
}
