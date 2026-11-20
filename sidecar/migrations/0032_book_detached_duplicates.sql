-- Label an empty duplicate that Locate File detached into Reading history
-- (ADR 0019 D2).
--
-- The detached durable record stays under its own uid so a synced Forget
-- cannot remove the same identity on another device. Without a marker the
-- row looks like a second copy of the book that owns the picked file. This
-- table names that owner so Reading history can say "Empty duplicate of …".
--
-- Local-only, like provider links: no sync trigger carries it between
-- devices. The marker clears when a file row binds to the uid (triggers
-- below) and cascades with the detached record. The owner link goes null
-- when the owner is forgotten or merged, but the snapshotted title keeps the
-- row explained.

CREATE TABLE book_detached_duplicates (
    book_uid           TEXT PRIMARY KEY REFERENCES book_records(uid) ON DELETE CASCADE,
    duplicate_of_uid   TEXT REFERENCES book_records(uid) ON DELETE SET NULL,
    duplicate_of_title TEXT,
    detached_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_book_detached_duplicates_owner
    ON book_detached_duplicates(duplicate_of_uid);

-- A file row can arrive through import, adopt, relink, or sync. The record
-- is no longer an empty duplicate once any of them binds bytes to it.
CREATE TRIGGER book_detached_duplicates_ai AFTER INSERT ON books
WHEN NEW.book_uid IS NOT NULL
BEGIN
    DELETE FROM book_detached_duplicates WHERE book_uid = NEW.book_uid;
END;

CREATE TRIGGER book_detached_duplicates_au AFTER UPDATE OF book_uid ON books
WHEN NEW.book_uid IS NOT NULL
BEGIN
    DELETE FROM book_detached_duplicates WHERE book_uid = NEW.book_uid;
END;
