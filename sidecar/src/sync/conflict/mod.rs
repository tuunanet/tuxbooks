//! The losing values the merge kept, as invisible diagnostics (ADR 0017 D2).
//! New races write a `sync_conflicts` row only: nothing in the sync engine or
//! on any user-facing surface counts, lists, or asks about it. The Copy
//! diagnostics report alone keeps a sample and a count for support. The rows
//! expire after 30 days, and a row whose winner no longer matches the mirror
//! is closed with the paired legacy issue, so the diagnostics trail stays
//! bounded without any interactive surface.

mod maintenance;
#[cfg(test)]
mod tests;

pub use maintenance::{expire, reconcile};

use serde_json::Value;

use super::model::TRASH_DAYS;

/// The durable book a conflict belongs to. A `book` conflict keys on the
/// entity uid itself; every other kind reads the mirror row.
pub(crate) const BOOK_UID_EXPR: &str =
    "COALESCE(CASE WHEN c.kind = 'book' THEN c.entity_uid END, e.book_uid)";

/// A legacy issue has no live conflict behind it, so the reconcile and expiry
/// sweep may close it.
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
