//! The auto-retry sweep (ADR 0017 D4): failures with a Retry action retry on
//! a schedule instead of waiting for a human.
//!
//! Structural contract: the sweep runs from `run_pass` after a pass, while
//! that call still holds `pass_lock`, and dispatches rows through the
//! `retry_locked` arms inline. It must never call `retry_issue`, which takes
//! `pass_lock` itself and would deadlock. It also cannot recurse: only the
//! top-level `run_pass` sweeps, and the sweep's retries go through
//! `run_pass_locked`, which does not.

use crate::error::AppError;

use super::{SyncIssueAction, SyncStatus};
use crate::repository::identity_backfill::retry_delay_secs;
use crate::sync::clock::{get_meta, now_rfc3339, set_meta, META_AUTO_RETRY};

/// Attempts before the sweep gives up on one row.
const DEFAULT_CAP: i64 = 5;
const BOOK_LIFECYCLE_CAP: i64 = 3;

/// The kinds the sweep owns, with the attempts each gets before it gives up
/// (ADR 0017 D4). `hash_failed` is excluded: its backfill loop already is the
/// schedule, and resetting its budget would defeat that. New Retry kinds stay
/// manual until a decision adds them here.
const AUTO_RETRY_CAPS: [(&str, i64); 8] = [
    ("projection_failed", DEFAULT_CAP),
    ("identity_failed", DEFAULT_CAP),
    ("reprojection_failed", DEFAULT_CAP),
    ("sync_failed", DEFAULT_CAP),
    ("operation_retrying", DEFAULT_CAP),
    ("cover_missing", DEFAULT_CAP),
    ("cover_blob_failed", DEFAULT_CAP),
    ("book_lifecycle_failed", BOOK_LIFECYCLE_CAP),
];

/// The per-kind attempt cap, or None when the sweep must not touch the kind.
fn auto_retry_cap(kind: &str) -> Option<i64> {
    AUTO_RETRY_CAPS
        .iter()
        .find(|(swept, _)| *swept == kind)
        .map(|(_, cap)| *cap)
}

/// SQL matching one open row with automatic work in flight: auto-retry is
/// on, the sweep owns the kind, and the spent attempts are under the
/// kind's cap. A fresh row (nothing spent yet) and a row paused for a
/// missing folder are in flight too — a skip is not an attempt, so neither
/// spends the budget. The status count excludes these rows so attention
/// means the machine gave up, the kind needs a human, or the machine is
/// off (ADR 0017 D4), never "a retry is scheduled". `enabled` is the same
/// setting the status snapshot reads: flipping it off ends the exclusion
/// at once, leaving every open row attention-worthy.
pub(super) fn in_flight_where(enabled: bool) -> String {
    if !enabled {
        // `NOT (0)` matches every open row: the machine is off and the
        // rows are the user's job.
        return "0".to_string();
    }
    let kinds = AUTO_RETRY_CAPS
        .iter()
        .map(|(kind, _)| format!("'{kind}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let caps = AUTO_RETRY_CAPS
        .iter()
        .map(|(kind, cap)| format!("WHEN '{kind}' THEN {cap}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("kind IN ({kinds}) AND auto_attempts < CASE kind {caps} ELSE 0 END")
}

/// Kinds whose repair needs a connected folder (ADR 0017 D4). While the
/// engine is disconnected or disabled they skip without spending budget.
const FOLDER_DEPENDENT: [&str; 5] = [
    "sync_failed",
    "cover_missing",
    "cover_blob_failed",
    "operation_retrying",
    "book_lifecycle_failed",
];

/// The detail suffix the sweep writes, cut from its first marker on, so a
/// later attempt replaces the stale state instead of stacking on it. Shared
/// with the manual Retry press, which strips the same markers.
pub(super) const STRIP_AUTO_RETRY_STATE: &str = "CASE
        WHEN instr(detail, ' (auto-retry ') > 0
        THEN substr(detail, 1, instr(detail, ' (auto-retry ') - 1)
        WHEN instr(detail, ' (gave up after ') > 0
        THEN substr(detail, 1, instr(detail, ' (gave up after ') - 1)
        ELSE detail
    END";

impl super::SyncService {
    /// Retry due rows after a pass. Best effort like the other sweeps: a
    /// failure here must not fail the pass that already completed.
    pub(super) async fn auto_retry_sweep(&self) {
        if let Err(err) = self.sweep_due_rows().await {
            eprintln!("sync issues: auto-retry sweep failed: {err}");
        }
    }

    async fn sweep_due_rows(&self) -> Result<(), AppError> {
        if !read_auto_retry_setting(&self.inner.pool).await? {
            return Ok(());
        }
        let now = now_rfc3339();
        type Row = (i64, String, String, Option<String>, i64);
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, issue_key, kind, file_name, auto_attempts
             FROM sync_issues
             WHERE resolved_at IS NULL
               AND kind <> 'hash_failed'
               AND (next_auto_retry_at IS NULL OR next_auto_retry_at <= ?1)",
        )
        .bind(&now)
        .fetch_all(&self.inner.pool)
        .await?;
        let status = self.status_snapshot();
        let mut changed = false;
        let mut cleared = false;
        for (id, issue_key, kind, file_name, attempts) in rows {
            let Some(cap) = auto_retry_cap(&kind) else {
                continue;
            };
            if SyncIssueAction::for_kind(&kind) != SyncIssueAction::Retry {
                continue;
            }
            if attempts >= cap {
                // Exhausted: the gave-up detail is already on the row. A
                // manual Retry resets the budget and puts it back in play.
                continue;
            }
            let connected = status.folder.is_some() && status.enabled;
            if FOLDER_DEPENDENT.contains(&kind.as_str()) && !connected {
                // A skip is not an attempt: the row keeps its budget and its
                // backoff clock for when the folder returns.
                continue;
            }
            if status.folder.is_none() {
                // Even the local repairs project into the folder's mirror;
                // without one the dispatch would only report an error.
                continue;
            }
            changed = true;
            let outcome = self
                .retry_locked(&kind, &issue_key, file_name.as_deref())
                .await;
            match outcome {
                Ok(true) => {
                    cleared = true;
                    self.resolve_auto_cleared(id).await?;
                }
                Ok(false) | Err(_) => {
                    self.record_auto_failure(id, attempts + 1, cap).await?;
                }
            }
        }
        if changed {
            // A retried identity or projection can write a durable merge, so
            // drain the reload marker here instead of waiting for a pass.
            if cleared {
                self.flush_library_reload().await?;
            }
            self.refresh_status().await?;
            self.emit_status();
        }
        Ok(())
    }

    /// Close one row the sweep proved clear.
    async fn resolve_auto_cleared(&self, id: i64) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE sync_issues SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL",
        )
        .bind(id)
        .bind(now_rfc3339())
        .execute(&self.inner.pool)
        .await?;
        Ok(())
    }

    /// Record a failed auto attempt: bump the count, move the backoff clock,
    /// and stamp the state onto the detail. At the cap the row stops
    /// retrying, keeps its next retry clock clear, and says it gave up — it
    /// stays open, because the machine giving up is attention-worthy.
    async fn record_auto_failure(&self, id: i64, attempts: i64, cap: i64) -> Result<(), AppError> {
        let (next, marker) = if attempts >= cap {
            (
                None::<String>,
                format!(" (gave up after {attempts} auto-retries)"),
            )
        } else {
            let delay = retry_delay_secs(attempts);
            let next = (chrono::Utc::now() + chrono::Duration::seconds(delay))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            (Some(next), format!(" (auto-retry {attempts}/{cap})"))
        };
        sqlx::query(&format!(
            "UPDATE sync_issues SET
                auto_attempts = ?2,
                next_auto_retry_at = ?3,
                detail = {STRIP_AUTO_RETRY_STATE} || ?4,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND resolved_at IS NULL"
        ))
        .bind(id)
        .bind(attempts)
        .bind(next)
        .bind(marker)
        .execute(&self.inner.pool)
        .await?;
        Ok(())
    }

    /// The kill switch (ADR 0017 D4): auto-retry is default-on, and this
    /// turns it off. The setting persists in sync_meta like the device name;
    /// a missing key reads as on, so an upgrade keeps retrying.
    pub async fn set_auto_retry(&self, enabled: bool) -> Result<SyncStatus, AppError> {
        let _guard = self.inner.pass_lock.lock().await;
        set_meta(
            &self.inner.pool,
            META_AUTO_RETRY,
            if enabled { "1" } else { "0" },
        )
        .await?;
        self.refresh_status().await?;
        self.emit_status();
        Ok(self.status_snapshot())
    }
}

/// Whether the sweep will run. A missing key means on.
pub(super) async fn read_auto_retry_setting(pool: &sqlx::SqlitePool) -> Result<bool, AppError> {
    Ok(get_meta(pool, META_AUTO_RETRY).await?.as_deref() != Some("0"))
}
