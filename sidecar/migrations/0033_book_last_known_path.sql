-- Last known path on the durable record (ADR 0014 D5, tuxbooks-t9p.1).
--
-- When a book's last file row is deleted, the durable record keeps the path
-- of the copy the reader opened, so Detached records and trash rows can show
-- "Was at <path>" and a later restore can offer the old folder. Nothing kept
-- a path before: the record only knew that a file used to exist.
--
-- The path is machine-local. It is written here, carried into the local
-- book_trash snapshot, and stripped from the machine-portable snapshot that
-- sync exchanges (shared_snapshot_json), so it never crosses devices.
-- Records detached before this change get the empty default.
--
-- The triggers clear the hint as soon as a file attaches again, whatever the
-- route: an import or relink inserting the row, a re-key binding it to the
-- record, or a reconnection flipping a stored row back to available.
--
-- Forward-only: a rolled-back app fails closed on the newer schema version.

ALTER TABLE book_records ADD COLUMN last_known_path TEXT;

CREATE TRIGGER book_records_last_known_path_ai AFTER INSERT ON books
WHEN NEW.book_uid IS NOT NULL
BEGIN
    UPDATE book_records SET last_known_path = NULL WHERE uid = NEW.book_uid;
END;

CREATE TRIGGER book_records_last_known_path_au AFTER UPDATE OF book_uid ON books
WHEN NEW.book_uid IS NOT NULL
BEGIN
    UPDATE book_records SET last_known_path = NULL WHERE uid = NEW.book_uid;
END;

CREATE TRIGGER book_records_last_known_path_avail AFTER UPDATE ON books
WHEN NEW.available = 1 AND (OLD.available = 0 OR OLD.book_uid IS NOT NEW.book_uid)
BEGIN
    UPDATE book_records SET last_known_path = NULL WHERE uid = NEW.book_uid;
END;
