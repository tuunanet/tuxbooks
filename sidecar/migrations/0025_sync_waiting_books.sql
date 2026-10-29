-- Waiting-book controls (ADR 0014, sync UI follow-up).
--
-- A durable book can have shared state in the mirror while no file row on
-- this machine binds to its content hash. Settings > Sync shows those books
-- as "Waiting for books". Ignoring one here only hides it on this device; the
-- mirror state stays in the folder so importing the exact bytes can still
-- project the progress and annotations. Other devices are untouched.
--
-- Forward-only: a rolled-back app fails closed on the newer schema version.

CREATE TABLE sync_ignored_books (
    book_uid   TEXT PRIMARY KEY,
    ignored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
