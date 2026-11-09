//! Deferred-adoption state (ADR 0018 D5): the open-reader registry and the
//! missing-blob visibility counter. Both are in-memory engine state that
//! lives exactly as long as the sidecar process, for the same reason:
//!
//! - The registry holds the books whose reader session is open on this
//!   device. An app restart closes every reader by definition, so persisted
//!   rows could only go stale (a book deferred forever because a crash ate
//!   its close event). The renderer registers on session start and
//!   re-registers after a restore, so in-memory is the correct lifetime: a
//!   missed close self-heals when the app exits.
//! - The counter tracks consecutive missing-blob passes per book for the
//!   adoption visibility sweep. A restart resets it, which is harmless: if
//!   the blob is still missing the issue re-records after N more passes,
//!   and the next pass runs immediately after a restart anyway.
//!
//! Registry keys are book uids exactly as `unsettled_copies` reports them
//! (`sync_book_bindings.book_uid`, the canonical live identity — merges
//! re-key bindings onto the winner). `commands::reader` converts the
//! renderer's public book id to this uid once, via `book_uid_for_id`.

use super::SyncService;

/// Consecutive missing-blob passes before the silent op-before-blob wait
/// (ADR 0018 D2) surfaces as a `book_file_adopt_failed` row. Chosen to be
/// several times the pass interval so an ordinary in-flight blob never
/// trips it, while a blob the origin never staged (a device storing the
/// book under an extension the origin's copy did not use) becomes visible
/// within a minute of passes.
pub const MISSING_BLOB_ISSUE_THRESHOLD: u32 = 5;

/// One book's consecutive missing-blob passes, pinned to the winning hash
/// they count against: a pointer change restarts the count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MissingBlobPasses {
    pub(super) hash: String,
    pub(super) passes: u32,
}

impl SyncService {
    /// Register an open reader session: adoption defers for this book until
    /// `reader_closed` releases it (or the process exits). The uid is the
    /// canonical book identity, as `unsettled_copies` reports it.
    pub fn reader_opened(&self, book_uid: String) {
        self.inner
            .deferred_books
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(book_uid);
    }

    /// Release a reader session. The next pass may adopt again. Removing an
    /// unregistered uid is a no-op, so close events may arrive in any order.
    pub fn reader_closed(&self, book_uid: String) {
        self.inner
            .deferred_books
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&book_uid);
    }

    /// Whether adoption must defer for this book: a reader session is open,
    /// and swapping bytes under it would resolve the session's next ranged
    /// reads against the new file.
    pub(super) fn is_deferred(&self, book_uid: &str) -> bool {
        self.inner
            .deferred_books
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(book_uid)
    }

    /// One more missing-blob pass for `book_uid` behind winning hash `hash`.
    /// Returns true when the count reached the visibility threshold, so the
    /// caller records the issue this pass. A pointer change restarts the
    /// count, because the wait now names different bytes.
    pub(super) fn record_missing_blob_pass(&self, book_uid: &str, hash: &str) -> bool {
        let mut map = self
            .inner
            .missing_blobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let passes = match map.get_mut(book_uid) {
            Some(state) if state.hash == hash => {
                state.passes += 1;
                state.passes
            }
            _ => {
                map.insert(
                    book_uid.to_string(),
                    MissingBlobPasses {
                        hash: hash.to_string(),
                        passes: 1,
                    },
                );
                1
            }
        };
        passes >= MISSING_BLOB_ISSUE_THRESHOLD
    }

    /// Stop counting for `book_uid`: the blob arrived or the copy settled.
    pub(super) fn clear_missing_blob(&self, book_uid: &str) {
        self.inner
            .missing_blobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(book_uid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::init_pool;
    use crate::rpc::EventEmitter;

    async fn service(dir: &std::path::Path) -> SyncService {
        let pool = init_pool(&dir.join("t.db")).await.unwrap();
        SyncService::new(pool, &dir.join("t.db"), EventEmitter::new(|_, _| {}))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn reader_opened_and_closed_mutate_only_the_in_memory_set() {
        let tmp = tempfile::tempdir().unwrap();
        let service = service(tmp.path()).await;

        assert!(!service.is_deferred("uid-a"), "nothing registered yet");
        service.reader_opened("uid-a".to_string());
        assert!(service.is_deferred("uid-a"));
        assert!(!service.is_deferred("uid-b"), "the set is per book");

        // Closing an unregistered uid is a silent no-op, and a registered
        // one empties the deferral.
        service.reader_closed("uid-b".to_string());
        assert!(service.is_deferred("uid-a"));
        service.reader_closed("uid-a".to_string());
        assert!(!service.is_deferred("uid-a"));
    }

    #[tokio::test]
    async fn missing_blob_counts_are_per_book_and_restart_on_pointer_change() {
        let tmp = tempfile::tempdir().unwrap();
        let service = service(tmp.path()).await;
        let below = MISSING_BLOB_ISSUE_THRESHOLD - 1;

        for _ in 0..below {
            assert!(!service.record_missing_blob_pass("uid-a", "hash-1"));
        }
        // Independent counts: uid-b's first pass does not ride uid-a's streak.
        assert!(!service.record_missing_blob_pass("uid-b", "hash-1"));
        // The Nth consecutive pass crosses the threshold and stays above it.
        assert!(service.record_missing_blob_pass("uid-a", "hash-1"));
        assert!(service.record_missing_blob_pass("uid-a", "hash-1"));

        // A pointer change restarts the count for that book alone.
        assert!(!service.record_missing_blob_pass("uid-a", "hash-2"));

        // uid-b still crosses on its own Nth pass.
        for _ in 0..MISSING_BLOB_ISSUE_THRESHOLD - 2 {
            assert!(!service.record_missing_blob_pass("uid-b", "hash-1"));
        }
        assert!(service.record_missing_blob_pass("uid-b", "hash-1"));
    }

    #[tokio::test]
    async fn clearing_the_missing_blob_count_restarts_the_streak() {
        let tmp = tempfile::tempdir().unwrap();
        let service = service(tmp.path()).await;

        for _ in 0..MISSING_BLOB_ISSUE_THRESHOLD {
            service.record_missing_blob_pass("uid-a", "hash-1");
        }
        service.clear_missing_blob("uid-a");
        assert!(
            !service.record_missing_blob_pass("uid-a", "hash-1"),
            "a settled or arrived blob restarts the wait"
        );
    }
}
