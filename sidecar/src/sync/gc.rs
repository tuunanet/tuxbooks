//! Staging-folder GC for `blobs/books/` (ADR 0018 D4): winners forever,
//! superseded for 90 days.
//!
//! The decision is a pure function of the winning content hashes the mirror
//! holds, the folder's own file names and mtimes, and the clock — so any
//! device can run it in a pass, and the plan never depends on which device
//! ran it. Nothing outside `blobs/books/` is eligible: covers, operations,
//! and device directories are off-limits, and the sweep never descends into
//! subdirectories.
//!
//! One rule covers every deletable shape the folder can hold — a blob whose
//! hash lost the pointer race, a staging temp the writer left between
//! create and rename, and off-grammar artifacts such as cloud "conflicting
//! copy" files — all are pruned once they are older than the window. A blob
//! whose hash IS a current winner is never deleted regardless of age: it is
//! the repair channel, and a late device only ever adopts the winner.
//!
//! The empty winning set: under the pure rule alone, an empty set makes
//! every blob superseded. The engine treats that as not enough information
//! — a mirror with no `file_version` rows cannot say which hashes are
//! winners (a fresh joiner), so it refuses to run the plan at all until the
//! mirror holds a pointer. Young blobs stay protected by the window either
//! way; the engine guard is what keeps old blobs safe, and
//! `engine/gc.rs` documents and tests it.

use std::collections::HashSet;
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::sync::clock::{get_meta, META_BLOB_GC};
use crate::sync::model::is_hex_hash;

use super::store;

/// How long a non-winning blob, staging temp, or off-grammar artifact
/// survives after it stops (or never started) being the winner (ADR 0018
/// D4). Chosen long enough that a device offline for weeks still finds the
/// loser blobs it raced against, short enough that the folder does not
/// grow without bound.
pub const BLOB_GC_RETENTION: Duration = Duration::from_secs(90 * 24 * 60 * 60);

/// Minimum time between GC sweeps (ADR 0018 D4: "GC ... in a pass", but the
/// pass interval itself is 10 seconds and a directory listing of a few
/// hundred blobs plus a stat each is real folder IO). One hour bounds the
/// staleness of the folder's contents at the level the ADR cares about —
/// prunes are measured in days — while keeping the per-pass cost at one
/// `sync_meta` read. The engine adds a startup run so a device that was
/// offline for weeks prunes shortly after boot instead of an hour in.
pub const BLOB_GC_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// One entry of the `blobs/books/` listing, as the pure decision sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDirEntry {
    pub name: String,
    pub modified: SystemTime,
}

/// Which folder entry this name is, as GC classifies it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum BlobEntryKind {
    /// A live content-addressed blob; carries its stem hash.
    Blob(String),
    /// A staging temp between create and rename. The writer's grammar is
    /// `.<blob>.<pid>.tmp` (`store::io::write_bytes_atomic`); anything in
    /// that shape is staging debris, never a blob a consumer reads.
    StagingTemp,
    /// Anything else: cloud conflict copies, dropped-in files, unknown
    /// names. Consumers ignore these; GC ages them out.
    OffGrammar,
}

fn classify(name: &str) -> BlobEntryKind {
    if let Some(blob) = store::book_blob_name(name) {
        // The grammar pins a 64-hex stem before the first dot.
        return BlobEntryKind::Blob(blob[..64].to_string());
    }
    let Some(inner) = name
        .strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(".tmp"))
    else {
        return BlobEntryKind::OffGrammar;
    };
    match inner.rsplit_once('.') {
        Some((blob, pid))
            if !pid.is_empty()
                && pid.bytes().all(|b| b.is_ascii_digit())
                && store::book_blob_name(blob).is_some() =>
        {
            BlobEntryKind::StagingTemp
        }
        _ => BlobEntryKind::OffGrammar,
    }
}

/// The deletions for one GC pass: every entry that is not a live winner and
/// is older than the retention window. A winner is never in the plan
/// regardless of age; a future mtime (clock skew, a provider reset) reads as
/// age zero and stays. The plan is names only — resolving them to paths and
/// touching the filesystem is the engine's job.
pub fn gc_plan(
    winning: &HashSet<String>,
    entries: &[BlobDirEntry],
    now: SystemTime,
) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| prune(winning, entry, now))
        .map(|entry| entry.name.clone())
        .collect()
}

fn prune(winning: &HashSet<String>, entry: &BlobDirEntry, now: SystemTime) -> bool {
    let Ok(age) = now.duration_since(entry.modified) else {
        return false;
    };
    match classify(&entry.name) {
        BlobEntryKind::Blob(hash) => !winning.contains(&hash) && age >= BLOB_GC_RETENTION,
        BlobEntryKind::StagingTemp | BlobEntryKind::OffGrammar => age >= BLOB_GC_RETENTION,
    }
}

/// Every content hash the mirror currently holds as a book's winning
/// `file_version` pointer. Tombstoned pointers are not winners: a deleted
/// pointer protects nothing. Hashes that fail the grammar are skipped, so a
/// malformed row can never protect (or forbid) a name.
pub async fn winning_hashes(pool: &SqlitePool) -> Result<HashSet<String>, AppError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT f.value_json FROM sync_state_fields f
         JOIN sync_state_entities e ON e.kind = f.kind AND e.entity_uid = f.entity_uid
         WHERE f.kind = 'file_version' AND f.field = 'content_hash' AND e.deleted = 0",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(json,)| {
            serde_json::from_str::<String>(&json)
                .ok()
                // Lowercase only: hashes are minted lowercase (stage_book_blob
                // names from the `{:x}` digest); if that ever changes, widen
                // this filter to match book_blob_name.
                .filter(|hash| is_hex_hash(hash))
        })
        .collect())
}

/// Whether a GC sweep is due: no stamp yet (or an unreadable one) is due at
/// once; otherwise the hourly interval governs. The stamp lives in
/// `sync_meta` like the auto-retry setting, so it survives restarts and the
/// check is one indexed read per pass.
pub async fn gc_due(pool: &SqlitePool, now: DateTime<Utc>) -> Result<bool, AppError> {
    match get_meta(pool, META_BLOB_GC).await? {
        None => Ok(true),
        Some(stamp) => Ok(DateTime::parse_from_rfc3339(&stamp)
            .map(|last| {
                now.signed_duration_since(last).num_seconds() >= BLOB_GC_INTERVAL.as_secs() as i64
            })
            .unwrap_or(true)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 24 * 60 * 60;
    const EPOCH: SystemTime = SystemTime::UNIX_EPOCH;

    fn entry(name: &str, age_days: u64) -> BlobDirEntry {
        BlobDirEntry {
            name: name.to_string(),
            modified: EPOCH + Duration::from_secs(age_days * DAY),
        }
    }

    fn plan(winning: &[&str], entries: &[BlobDirEntry], now_days: u64) -> Vec<String> {
        let winning: HashSet<String> = winning.iter().map(|hash| hash.to_string()).collect();
        gc_plan(
            &winning,
            entries,
            EPOCH + Duration::from_secs(now_days * DAY),
        )
    }

    fn hash(byte: u8) -> String {
        format!("{:064x}", byte as u128)
    }

    #[test]
    fn superseded_old_blob_is_deleted() {
        let loser = hash(1);
        let entries = [entry(&format!("{loser}.epub"), 0)];
        assert_eq!(
            plan(&[&hash(2)], &entries, 91),
            vec![format!("{loser}.epub")]
        );
    }

    #[test]
    fn superseded_recent_blob_is_kept() {
        let loser = hash(1);
        let entries = [entry(&format!("{loser}.epub"), 0)];
        assert!(
            plan(&[&hash(2)], &entries, 89).is_empty(),
            "inside the window"
        );
    }

    #[test]
    fn winner_blob_is_kept_regardless_of_age() {
        let winner = hash(2);
        let entries = [entry(&format!("{winner}.epub"), 0)];
        // 400 days old: far past the window, still untouchable.
        assert!(plan(&[&winner], &entries, 400).is_empty());
    }

    #[test]
    fn winner_check_uses_the_full_hash() {
        let near = hash(3);
        let winner = format!("{}0", &hash(3)[..63]);
        let entries = [entry(&format!("{near}.pdf"), 0)];
        assert_eq!(
            plan(&[&winner], &entries, 91),
            vec![format!("{near}.pdf")],
            "a stem one character off the winner is superseded"
        );
    }

    #[test]
    fn off_grammar_old_artifact_is_deleted() {
        let entries = [entry("old book (conflicting copy from 'Laptop').epub", 0)];
        assert_eq!(plan(&[], &entries, 91), vec![entries[0].name.clone()]);
    }

    #[test]
    fn off_grammar_recent_artifact_is_kept() {
        let entries = [entry("new (conflicting copy).epub", 0)];
        assert!(plan(&[], &entries, 89).is_empty());
    }

    #[test]
    fn stale_staging_temp_is_deleted_after_the_window() {
        let loser = hash(4);
        let temp = format!(".{loser}.epub.4242.tmp");
        let entries = [entry(&temp, 0)];
        assert_eq!(plan(&[&hash(5)], &entries, 91), vec![temp]);
    }

    #[test]
    fn recent_staging_temp_is_kept() {
        let loser = hash(4);
        let temp = format!(".{loser}.epub.4242.tmp");
        let entries = [entry(&temp, 0)];
        assert!(plan(&[&hash(5)], &entries, 89).is_empty());
    }

    #[test]
    fn dot_part_names_are_off_grammar_and_age_out() {
        // The ADR sketch wrote `<hash>.part`; the writer never does, so the
        // shape is off-grammar and follows the off-grammar rule.
        let part = format!("{}.part", hash(6));
        let entries = [entry(&part, 0)];
        assert_eq!(plan(&[], &entries, 91), vec![part.clone()]);
        // And it is never mistaken for a winner's blob even when the stem
        // matches a winning hash: a temp is not a repair channel.
        assert_eq!(plan(&[&hash(6)], &entries, 91), vec![part]);
    }

    #[test]
    fn future_mtime_is_kept() {
        let loser = hash(7);
        let entries = [BlobDirEntry {
            name: format!("{loser}.epub"),
            modified: EPOCH + Duration::from_secs(100 * DAY),
        }];
        assert!(
            plan(&[&hash(8)], &entries, 91).is_empty(),
            "a future mtime reads as age zero"
        );
    }

    #[test]
    fn empty_winning_set_ages_old_blobs_out_under_the_pure_rule() {
        // The pure rule alone: with no winners, everything is superseded,
        // and only the window protects recent blobs. The engine never
        // reaches this shape — an empty mirror skips GC entirely
        // (engine/gc.rs), which is the tested safety net for fresh joiners.
        let loser = hash(9);
        let young = hash(10);
        let entries = [
            entry(&format!("{loser}.epub"), 0),
            BlobDirEntry {
                name: format!("{young}.epub"),
                modified: EPOCH + Duration::from_secs(150 * DAY),
            },
        ];
        let deletions = plan(&[], &entries, 200);
        assert_eq!(deletions, vec![format!("{loser}.epub")]);
    }

    #[tokio::test]
    async fn tombstoned_pointer_hash_is_not_a_winner() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&dir.path().join("t.db"))
            .await
            .unwrap();
        let live = hash(11);
        let tombstoned = hash(12);
        for (uid, deleted) in [(&live, 0), (&tombstoned, 1)] {
            sqlx::query(
                "INSERT INTO sync_state_entities (kind, entity_uid, deleted)
                 VALUES ('file_version', ?1, ?2)",
            )
            .bind(uid)
            .bind(deleted)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO sync_state_fields
                    (kind, entity_uid, field, value_json, hlc_wall, hlc_counter, hlc_device)
                 VALUES ('file_version', ?1, 'content_hash', ?2, 1, 0, 'other')",
            )
            .bind(uid)
            .bind(format!("\"{uid}\""))
            .execute(&pool)
            .await
            .unwrap();
        }
        // The tombstone is excluded at the query itself: its hash is absent
        // exactly as if it were never a winner at all.
        let winning = winning_hashes(&pool).await.unwrap();
        assert_eq!(winning, HashSet::from([live.clone()]));
        // The GC consequence: a blob whose only pointer is the tombstone is
        // superseded once the window passes, while the live winner stays.
        let entries = [
            entry(&format!("{live}.epub"), 0),
            entry(&format!("{tombstoned}.epub"), 0),
        ];
        assert_eq!(
            plan(&[&live], &entries, 91),
            vec![format!("{tombstoned}.epub")]
        );
    }

    #[tokio::test]
    async fn gc_due_reads_the_stamp_and_recovers_from_a_bad_one() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::connection::init_pool(&dir.path().join("t.db"))
            .await
            .unwrap();
        let now = DateTime::parse_from_rfc3339("2026-11-09T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        // No stamp: due at once.
        assert!(gc_due(&pool, now).await.unwrap());
        crate::sync::clock::set_meta(&pool, META_BLOB_GC, "2026-11-09T11:29:59.000Z")
            .await
            .unwrap();
        // 30 minutes in: not yet.
        assert!(!gc_due(&pool, now).await.unwrap());
        crate::sync::clock::set_meta(&pool, META_BLOB_GC, "2026-11-09T11:00:00.000Z")
            .await
            .unwrap();
        // Exactly an hour in: due.
        assert!(gc_due(&pool, now).await.unwrap());
        crate::sync::clock::set_meta(&pool, META_BLOB_GC, "not-a-timestamp")
            .await
            .unwrap();
        // An unreadable stamp is due: never let a corrupt value wedge GC.
        assert!(gc_due(&pool, now).await.unwrap());
    }
}
