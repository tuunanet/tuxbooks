use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A third-party reading status as the provider reports it. TuxBooks does not
/// grow a second reading-status model: the value is cached on the provider
/// link for display and adapter decisions, while reading progress keeps using
/// `reading_progress` (docs/PROVIDERS.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum ProviderReadingStatus {
    WantToRead,
    Reading,
    Paused,
    Finished,
    Dropped,
}

impl ProviderReadingStatus {
    /// Only `Finished` changes TuxBooks' existing progress semantics: it sets
    /// the book to 100%, exactly like `mark_book_finished`.
    pub const fn completes_book(self) -> bool {
        matches!(self, Self::Finished)
    }
}

/// One link between a durable book and the same book on a third-party
/// service. Mirrors `book_provider_links`; `book_uid` is the durable identity,
/// so a link survives every file row leaving the library.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLink {
    pub book_uid: String,
    pub provider: String,
    pub remote_id: String,
    /// The provider's last known reading status; NULL until it reports one.
    pub status: Option<ProviderReadingStatus>,
    pub status_updated_at: Option<DateTime<Utc>>,
    pub linked_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
