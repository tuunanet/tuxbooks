-- Crash-safe identity refresh and duplicate-copy projection (docs/SYNC.md).
--
-- `books.rehash_pending` is set before a metadata embed rewrites the file. If
-- the process dies before the size/mtime snapshot is refreshed, the identity
-- sweep still rehashes the book and publishes the new content-hash alias.
--
-- `sync_reproject` holds a book uuid whose canonical local row disappeared.
-- The engine projects the shared state onto the next bound row, so deleting
-- one copy of a duplicate does not make the other copy look empty.

ALTER TABLE books ADD COLUMN rehash_pending INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sync_reproject (
    book_uid     TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- BEFORE DELETE, so the binding row is still visible when the parent book is
-- removed. The FK cascade deletes the binding afterwards.
CREATE TRIGGER sync_books_reproject_bd BEFORE DELETE ON books
BEGIN
    INSERT INTO sync_reproject (book_uid)
    SELECT book_uid FROM sync_book_bindings WHERE book_id = OLD.id
    ON CONFLICT(book_uid) DO UPDATE SET
        requested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;
