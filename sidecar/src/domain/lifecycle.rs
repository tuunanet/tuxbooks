use serde::{Deserialize, Serialize};

/// What the user chose when a restored book's current identity already has
/// new user state (ADR 0014 D5). `None` asks the backend to restore silently
/// when it can and report a conflict when it cannot. `LinkEdition` and
/// `WithoutFile` answer a different-bytes report (tuxbooks-t9p.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreMode {
    Replace,
    Keep,
    Merge,
    /// Restore the record detached and link it to the book that owns the
    /// picked file as a different edition (ADR 0019 D3).
    LinkEdition,
    /// Restore the record detached and leave the picked file alone.
    WithoutFile,
}

/// The outcome of one restore attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreStatus {
    /// The old record and state are back.
    Restored,
    /// The user kept the current book; the old snapshot was discarded.
    Kept,
    /// The current identity holds any of the six kinds of user state and no
    /// mode was chosen, so nothing changed.
    Conflict,
    /// The picked bytes match none of the snapshot's hashes (ADR 0019 D5):
    /// nothing changed, and the lossless choices are on offer.
    DifferentBytes,
    /// The trash entry is gone, expired, or already restored.
    NotFound,
}

/// New state found on the book that owns the restored entry's place (the
/// Forget-time fresh identity, or the library book that owns a picked file).
/// The UI uses this to explain the Replace / Keep / Merge choice; the fields
/// name all six kinds of user state, the same set Locate File counts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreConflict {
    pub progress_percent: Option<f64>,
    pub annotation_count: i64,
    pub collections: i64,
    pub has_metadata_overrides: bool,
    pub provider_links: i64,
    pub edition_links: i64,
}

/// What the UI offers when a picked file's bytes match none of the trash
/// snapshot's content hashes (ADR 0019 D3). The identity and state counts
/// describe the forgotten book as its snapshot holds them; `owner_book_id`
/// names the library book that already owns the pick, and only a pick with
/// an owner can be linked as an edition.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreDifferentBytes {
    pub title: Option<String>,
    pub author: Option<String>,
    pub progress_percent: Option<f64>,
    pub annotation_count: i64,
    pub collections: i64,
    pub has_metadata_overrides: bool,
    pub provider_links: i64,
    pub owner_book_id: Option<i64>,
}

/// Result of `restore_book`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub status: RestoreStatus,
    /// The durable book now holding the restored or kept state.
    pub book_id: Option<i64>,
    pub book_uid: Option<String>,
    /// Public ids this restore deleted: the fresh identity, and the old record
    /// when it comes back under a new id. Internal to the command, which turns
    /// them into `library-changed` removals; not part of the RPC result.
    #[serde(skip)]
    pub replaced_book_ids: Vec<i64>,
    pub conflict: Option<RestoreConflict>,
    /// Set with `RestoreStatus::DifferentBytes`: the lossless choices for a
    /// pick whose bytes match none of the snapshot's hashes.
    pub different_bytes: Option<RestoreDifferentBytes>,
}

/// Result of forgetting one book. `replacement_book_id` is the fresh identity
/// when the file stayed in the library; `None` when the book had no file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetOutcome {
    pub forgotten_book_id: i64,
    pub replacement_book_id: Option<i64>,
    pub trash_id: i64,
}

/// Result of forgetting a selection of books.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkForgetOutcome {
    pub forgotten: i64,
    pub trash_ids: Vec<i64>,
}

/// One restorable Forget in the 30-day trash.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookTrashEntry {
    pub id: i64,
    pub book_id: i64,
    pub book_uid: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub deleted_at: String,
    pub expires_at: String,
    pub progress_percent: Option<f64>,
    pub annotation_count: i64,
    /// The fresh identity the file was rebound to, when the book stayed in the
    /// library at Forget time.
    pub replacement_book_id: Option<i64>,
    /// Whether that fresh identity holds any of the six kinds of user state
    /// now. Restore with `true` needs a Replace / Keep / Merge choice.
    pub has_new_state: bool,
    /// Path of the copy the reader opened, from the snapshot (Last known
    /// path, tuxbooks-t9p.1). Machine-local: never crosses sync.
    pub last_known_path: Option<String>,
}
