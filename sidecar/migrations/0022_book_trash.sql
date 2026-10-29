-- Forgettable books and their 30-day restore snapshot (ADR 0014 D5,
-- ticket tuxbooks-ip6.7).
--
-- Forget removes a durable book's identity and state and, when the book still
-- has a file row, rebinds that file to a fresh identity so the library entry
-- never disappears. The old record and everything the user owns is captured
-- before the delete so it can be restored inside the same 30-day window as
-- annotation and collection deletes.
--
-- This is deliberately a dedicated table. `sync_trash` stores one deleted
-- sync entity (an annotation or a collection); a whole book is not an entity
-- of that shape and overloading it would lie about the schema.
--
-- `replacement_book_uid` names the fresh identity created by Forget. Restore
-- uses it to decide whether the current book already has new state and to
-- merge back into the entry the user is still looking at. A book forgotten
-- with no file has no replacement and restores directly into Reading history.
--
-- Forward-only: a rolled-back app fails closed on the newer schema version.

CREATE TABLE book_trash (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id              INTEGER NOT NULL,
    book_uid             TEXT NOT NULL,
    replacement_book_uid TEXT,
    snapshot_json        TEXT NOT NULL,
    deleted_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at           TEXT NOT NULL,
    restored_at          TEXT
);

CREATE INDEX book_trash_open ON book_trash(restored_at, expires_at);
CREATE INDEX book_trash_replacement ON book_trash(replacement_book_uid);
