//! The closed set of user-visible sync-issue kinds
//! (docs/SYNC_ISSUES.md, "Kinds" table).
//!
//! `sync_issues.kind` stores these exact strings: raw SQL, diagnostics, and
//! the renderer read the column back, so the spelling is frozen. The enum
//! gives every dispatch site — the action table, target labels, Retry, the
//! auto-clear sweep, the auto-retry caps — an exhaustive match over one type:
//! a new kind with no handling becomes a compile error instead of a silent
//! fall-through (the `book_file_adopt_failed` bug fixed in PR #418).

/// One user-visible sync-issue kind. The spelling is the storage format:
/// `sync_issues.kind`, diagnostics, and the renderer all read these strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SyncIssueKind {
    ProjectionFailed,
    IdentityFailed,
    ReprojectionFailed,
    BookLifecycleFailed,
    SyncFailed,
    OperationRetrying,
    OperationRejected,
    HashFailed,
    CoverMissing,
    CoverBlobFailed,
    DuplicateBook,
    InvalidDirtyKind,
    BookSnapshotMissing,
    BookSnapshotInvalid,
    ForgetMembershipSkipped,
    RestoreConflict,
    BookBlobOversize,
    BookFileAdoptFailed,
}

impl SyncIssueKind {
    /// Every variant, in the kinds table's order. `parse` looks membership up
    /// here, and the doc test below ties this list to docs/SYNC_ISSUES.md,
    /// so the three (doc, `ALL`, variants) only stay in step together.
    pub const ALL: [Self; 18] = [
        Self::ProjectionFailed,
        Self::IdentityFailed,
        Self::ReprojectionFailed,
        Self::BookLifecycleFailed,
        Self::SyncFailed,
        Self::OperationRetrying,
        Self::OperationRejected,
        Self::HashFailed,
        Self::CoverMissing,
        Self::CoverBlobFailed,
        Self::DuplicateBook,
        Self::InvalidDirtyKind,
        Self::BookSnapshotMissing,
        Self::BookSnapshotInvalid,
        Self::ForgetMembershipSkipped,
        Self::RestoreConflict,
        Self::BookBlobOversize,
        Self::BookFileAdoptFailed,
    ];

    /// The canonical string as stored in `sync_issues.kind`. Exhaustive on
    /// purpose: a new variant must spell itself out here.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProjectionFailed => "projection_failed",
            Self::IdentityFailed => "identity_failed",
            Self::ReprojectionFailed => "reprojection_failed",
            Self::BookLifecycleFailed => "book_lifecycle_failed",
            Self::SyncFailed => "sync_failed",
            Self::OperationRetrying => "operation_retrying",
            Self::OperationRejected => "operation_rejected",
            Self::HashFailed => "hash_failed",
            Self::CoverMissing => "cover_missing",
            Self::CoverBlobFailed => "cover_blob_failed",
            Self::DuplicateBook => "duplicate_book",
            Self::InvalidDirtyKind => "invalid_dirty_kind",
            Self::BookSnapshotMissing => "book_snapshot_missing",
            Self::BookSnapshotInvalid => "book_snapshot_invalid",
            Self::ForgetMembershipSkipped => "forget_membership_skipped",
            Self::RestoreConflict => "restore_conflict",
            Self::BookBlobOversize => "book_blob_oversize",
            Self::BookFileAdoptFailed => "book_file_adopt_failed",
        }
    }

    /// Parse a stored kind. Membership comes from `ALL`, so a kind listed in
    /// docs/SYNC_ISSUES.md but missing from `ALL` fails the round-trip test
    /// instead of parsing as unknown. Unknown strings (`conflict` legacy
    /// rows, kinds from another build) return `None`; every dispatch site
    /// keeps its historical fall-through for `None`.
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|kind| kind.as_str() == value)
    }
}

#[cfg(test)]
mod tests {
    use super::SyncIssueKind;

    /// docs/SYNC_ISSUES.md is the spec: its Kinds table is the canonical
    /// list of kinds this build knows.
    const DOC: &str = include_str!("../../../docs/SYNC_ISSUES.md");

    /// The first column of every row in the Kinds table, one backticked
    /// spelling per kind (some rows list two).
    fn doc_kinds() -> Vec<String> {
        let lines = DOC.lines().skip_while(|line| *line != "## Kinds");
        let mut kinds = Vec::new();
        for line in lines.skip_while(|line| !line.starts_with("| ---")) {
            if !line.starts_with('|') {
                break;
            }
            if line.starts_with("| ---") {
                continue;
            }
            let cell = line.split('|').nth(1).unwrap_or_default();
            kinds.extend(cell.split('`').skip(1).step_by(2).map(str::to_string));
        }
        kinds
    }

    #[test]
    fn all_lists_each_kind_once() {
        let mut seen: Vec<&str> = Vec::new();
        for kind in SyncIssueKind::ALL {
            let spelling = kind.as_str();
            assert!(
                !seen.contains(&spelling),
                "SyncIssueKind::ALL lists {spelling} twice"
            );
            seen.push(spelling);
        }
    }

    #[test]
    fn variants_match_the_docs_kinds_table() {
        let mut from_doc = doc_kinds();
        from_doc.sort();
        let mut from_enum: Vec<String> = SyncIssueKind::ALL
            .iter()
            .map(|kind| kind.as_str().to_string())
            .collect();
        from_enum.sort();
        assert_eq!(
            from_enum, from_doc,
            "SyncIssueKind and the kinds table in docs/SYNC_ISSUES.md disagree; \
             the doc is the spec"
        );
    }

    #[test]
    fn canonical_strings_round_trip_byte_identically() {
        for stored in doc_kinds() {
            let kind = SyncIssueKind::parse(&stored)
                .unwrap_or_else(|| panic!("canonical kind {stored} does not parse"));
            assert_eq!(
                kind.as_str(),
                stored,
                "canonical kind {stored} formats back differently"
            );
        }
    }
}
