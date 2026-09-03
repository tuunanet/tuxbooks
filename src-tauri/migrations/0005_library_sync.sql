-- Library synchronization (ROADMAP milestone 3): the library evolves from a
-- one-time importer into a continuously reconciled index.
--
-- `library_locations` records the filesystem roots the watcher keeps under
-- observation; only paths imported through `scan_library` (or the test
-- seeding) are watched, so books outside watched locations are never
-- touched by reconciliation.
--
-- `books.available` marks whether the source file still exists at `path`
-- (1) or has disappeared/moved (0). A missing file never deletes the row:
-- metadata, collections, and reading progress are preserved for
-- reconnection.
--
-- `books.file_size` / `books.file_mtime` (unix seconds) snapshot the file at
-- import time so the watcher can tell real modifications from duplicate
-- events without re-parsing the document.

CREATE TABLE library_locations (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    path     TEXT NOT NULL UNIQUE,
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE books ADD COLUMN available  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE books ADD COLUMN file_size  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE books ADD COLUMN file_mtime INTEGER NOT NULL DEFAULT 0;
