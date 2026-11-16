//! The trio every dispatch path reads from one `sync_issues` row.

use crate::sync::kind::SyncIssueKind;

/// The three fields a dispatch path works from: which kind of issue, its
/// internal key, and the operation file it came from. Row readers build one
/// of these instead of passing the three along separately, parsing the
/// stored kind at the row edge. `None` is what `parse` returns for a string
/// this build does not know; `SyncIssueAction::for_kind` says why it stays
/// `None` rather than becoming an `Unknown` variant. Each dispatch function
/// keeps its historical treatment of `None`: `issue_target` labels,
/// `issue_cleared` skips, `retry_locked` refuses.
#[derive(Debug, Clone, Copy)]
pub(super) struct SyncIssueRef<'a> {
    pub kind: Option<SyncIssueKind>,
    pub issue_key: &'a str,
    pub file_name: Option<&'a str>,
}

impl<'a> SyncIssueRef<'a> {
    /// The key's value after `prefix` (colon included), or `None` when the
    /// key does not carry the prefix. Every prefix read of an issue key in
    /// the engine goes through here. Each caller keeps its own policy for
    /// `None` and for the value: Retry reports a key it cannot use, the
    /// auto-clear sweep treats it as "not cleared". The one deliberate
    /// exception is `issue_target`'s label suffix in issues.rs, which splits
    /// on the first colon regardless of prefix so an unknown kind still gets
    /// a label.
    pub(super) fn key_after(self, prefix: &str) -> Option<&'a str> {
        let SyncIssueRef { issue_key, .. } = self;
        issue_key.strip_prefix(prefix)
    }
}

#[cfg(test)]
mod tests {
    use super::{SyncIssueKind, SyncIssueRef};

    fn issue(key: &'static str) -> SyncIssueRef<'static> {
        SyncIssueRef {
            kind: Some(SyncIssueKind::ProjectionFailed),
            issue_key: key,
            file_name: None,
        }
    }

    #[test]
    fn key_after_keeps_an_empty_remainder_visible_to_its_caller() {
        // The parser stays raw: Retry rejects an empty value itself, while
        // the sweep historically treats `reproject:` as a present-but-empty
        // value, so filtering here would change one of the two.
        assert_eq!(issue("reproject:").key_after("reproject:"), Some(""));
    }
}
