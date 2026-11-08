-- Auto-retry sweep bookkeeping for sync issues (ADR 0017 D4).
--
-- Failures with a Retry action used to sit open until a human pressed Retry
-- or the condition cleared on its own. The engine now retries them on a
-- schedule after each pass: `auto_attempts` counts the automatic tries
-- against a per-kind cap, and `next_auto_retry_at` holds the backoff clock
-- (the same schedule as the hash backfill: 1 minute, 5 minutes, 15 minutes,
-- 1 hour, 6 hours, then 24 hours as the cap). A row that reaches its cap
-- stays open with a gave-up detail, and a manual Retry resets both columns,
-- which grants a fresh budget.
--
-- The columns default so existing open rows enter the schedule at zero;
-- `next_auto_retry_at` NULL reads as due.

ALTER TABLE sync_issues ADD COLUMN auto_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_issues ADD COLUMN next_auto_retry_at TEXT;
