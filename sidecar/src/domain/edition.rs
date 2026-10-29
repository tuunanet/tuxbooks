use serde::Serialize;

/// One durable book linked to another as a different edition of the same
/// work (ADR 0014 D9). The two books keep separate identities, files,
/// progress rows, and annotations; this is a user-confirmed relation, not a
/// merge.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditionBook {
    pub id: i64,
    pub book_uid: String,
    pub title: Option<String>,
    pub author: Option<String>,
    /// Whether the linked edition currently has a file in the library. A
    /// linked edition with no file lives in Reading history.
    pub in_library: bool,
}

/// Result of one confirmed cross-edition link.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditionLinkOutcome {
    pub source_book_id: i64,
    pub target_book_id: i64,
    pub source_book_uid: String,
    pub target_book_uid: String,
    /// The source percentage seeded into the target, or `None` when the
    /// source had no progress or the target already had its own.
    pub copied_progress_percent: Option<f64>,
    /// Providers whose link and cached status moved to the target edition.
    pub moved_providers: Vec<String>,
}
