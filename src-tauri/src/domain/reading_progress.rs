use chrono::{DateTime, Utc};
use serde::Serialize;

/// Where the user stopped reading a given book. Mirrors the `reading_progress` table.
///
/// Progress stays format-specific: EPUB locates a Readium locator (the
/// serialized `locator`/`locations` JSON written by the Readium reader;
/// `cfi` + `chapter_href` keep the foliate-era locator as provenance until
/// the migration adapter replaces it), PDF locates a page number.
/// `progress_percent` is the coarse shell-level position either way.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingProgress {
    pub book_id: i64,
    pub chapter_href: Option<String>,
    pub cfi: Option<String>,
    pub character_offset: Option<i64>,
    pub page_number: Option<i64>,
    pub scroll_offset: Option<f64>,
    pub progress_percent: Option<f64>,
    /// Serialized Readium locator JSON (EPUB, engine-locator columns).
    pub locator: Option<String>,
    /// The locator's totalProgression (0..=1), for coarse use.
    pub progression: Option<f64>,
    /// Serialized Readium `locations` object JSON.
    pub locations: Option<String>,
    /// Engine that wrote the locator (`"readium"`); NULL for foliate-era rows.
    pub engine: Option<String>,
    /// Locator schema version of the stored conversion.
    pub schema_version: Option<i64>,
    pub updated_at: DateTime<Utc>,
}

/// Writable subset of [`ReadingProgress`]. `book_id` is passed separately.
/// Fields the caller leaves unset preserve the stored value for the
/// engine-locator columns (see the repository upsert); the legacy columns
/// are always written as provided.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProgressUpdate {
    pub chapter_href: Option<String>,
    pub cfi: Option<String>,
    pub character_offset: Option<i64>,
    pub page_number: Option<i64>,
    pub scroll_offset: Option<f64>,
    pub progress_percent: Option<f64>,
    pub locator: Option<String>,
    pub progression: Option<f64>,
    pub locations: Option<String>,
    pub engine: Option<String>,
    pub schema_version: Option<i64>,
}
