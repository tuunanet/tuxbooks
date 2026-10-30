-- Conflict review. A losing value stays in sync_conflicts until the user
-- resolves it or the 30-day window expires, so the queue can be read without
-- changing the last-writer-wins result. Resolved rows stay in place for the
-- audit trail; open, unexpired rows drive the Settings count and list.

ALTER TABLE sync_conflicts ADD COLUMN resolved_at TEXT;

CREATE INDEX sync_conflicts_open ON sync_conflicts(resolved_at);
