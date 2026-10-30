-- Bounded automatic retry for a failed content hash. The attempt count drives
-- the delay; it resets when the file snapshot changes or the hash succeeds.
-- A failed hash used to leave a migration_issues row, which offered no repair
-- beyond a relink. The failure now lives on the book (hash_state plus the retry
-- clock) and, when sync is on, in sync_issues with a Retry action.

ALTER TABLE books ADD COLUMN hash_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE books ADD COLUMN hash_retry_at TEXT;

-- The old path left open rows that nothing would ever clear. Resolve them so
-- an upgrade does not show a relink issue that no longer has a repair path.
UPDATE migration_issues
SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE kind = 'hash_failed' AND resolved_at IS NULL;

-- One open issue per key. Older versions deduped in application code, which
-- two concurrent status refreshes could still race. Collapse any duplicate
-- that survived before adding the constraint, keeping the newest row.
UPDATE sync_issues
SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE resolved_at IS NULL
  AND id NOT IN (
      SELECT MAX(id) FROM sync_issues WHERE resolved_at IS NULL GROUP BY issue_key
  );

CREATE UNIQUE INDEX sync_issues_open_key
    ON sync_issues(issue_key) WHERE resolved_at IS NULL;

-- The failed-hash sweep reads by state; the library's book query aggregates
-- across a book's file rows by hash state.
CREATE INDEX books_hash_state ON books(hash_state);
