use serde::{Deserialize, Serialize};

/// What the user chose when a restored book's current identity already has
/// new reading state (ADR 0014 D5). `None` asks the backend to restore
/// silently when it can and report a conflict when it cannot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreMode {
    Replace,
    Keep,
    Merge,
}

/// The outcome of one restore attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreStatus {
    /// The old record and state are back.
    Restored,
    /// The user kept the current book; the old snapshot was discarded.
    Kept,
    /// The current identity has new progress or annotations and no mode was
    /// chosen, so nothing changed.
    Conflict,
    /// The trash entry is gone, expired, or already restored.
    NotFound,
}

/// New state found on the fresh identity after a Forget. The UI uses this to
/// explain the Replace / Keep / Merge choice.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreConflict {
    pub progress_percent: Option<f64>,
    pub annotation_count: i64,
}

/// Result of `restore_book`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub status: RestoreStatus,
    /// The durable book now holding the restored or kept state.
    pub book_id: Option<i64>,
    pub book_uid: Option<String>,
    pub conflict: Option<RestoreConflict>,
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
    /// Whether that fresh identity has progress or annotations now. Restore
    /// with `true` needs a Replace / Keep / Merge choice.
    pub has_new_state: bool,
}
