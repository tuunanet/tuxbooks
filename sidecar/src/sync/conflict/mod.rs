//! The losing values the merge kept, and the settlement that legacy rows —
//! recorded before races went silent (ADR 0017 D1) — still offer in the
//! review surface. New races write a `sync_conflicts` diagnostic row only.
//!
//! Resolving never patches only this machine. `apply_loser` publishes a normal
//! operation with a fresh clock, so every device replays it and converges. The
//! losing value stays in `sync_conflicts` until the row is resolved or the
//! 30-day window expires.
//!
//! The queue is also reconciled against the mirror on every status refresh. A
//! conflict whose winner has been overwritten is no longer a choice, so it
//! closes on every device that replays the newer write.

mod maintenance;
mod review;
mod settle;
#[cfg(test)]
mod tests;

pub use maintenance::{expire, reconcile};
pub use review::{field_label, list, SyncConflict};
pub use settle::{apply_blocked_reason, apply_loser, open, settle, OpenConflict, Resolution};

use serde_json::Value;

use super::model::TRASH_DAYS;

/// The durable book a conflict belongs to. A `book` conflict keys on the
/// entity uid itself; every other kind reads the mirror row.
pub(crate) const BOOK_UID_EXPR: &str =
    "COALESCE(CASE WHEN c.kind = 'book' THEN c.entity_uid END, e.book_uid)";

/// An issue has no live conflict behind it. Shared by the reconcile and expiry
/// sweep and the single-key settlement path so the key join lives in one place.
pub(super) const NO_LIVE_CONFLICT: &str = "NOT EXISTS (
    SELECT 1 FROM sync_conflicts c
    WHERE c.resolved_at IS NULL
      AND 'conflict:' || c.kind || ':' || c.entity_uid || ':' || c.field = sync_issues.issue_key
)";

pub(super) fn cutoff() -> String {
    (chrono::Utc::now() - chrono::Duration::days(TRASH_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(super) fn parse_value(json: &str) -> Value {
    serde_json::from_str(json).unwrap_or(Value::Null)
}
