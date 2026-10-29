-- Reading-history search (ADR 0014, ticket tuxbooks-ip6.5).
--
-- The 0019 `books_fts_books_ad` trigger deleted a book's index row when its
-- last file row was removed and re-inserted it only while another file
-- existed. That left every book that moved to Reading history unsearchable,
-- even though the index is over the durable book and the view is supposed to
-- search them. Recreate the trigger so the durable row always stays indexed
-- (with a NULL path when no file is present), and backfill any book the old
-- trigger already dropped.
--
-- Forward-only: a rolled-back app fails closed on the newer schema version.

DROP TRIGGER IF EXISTS books_fts_books_ad;

CREATE TRIGGER books_fts_books_ad AFTER DELETE ON books
WHEN OLD.book_uid IS NOT NULL
BEGIN
    DELETE FROM books_fts
    WHERE rowid = (SELECT id FROM book_records WHERE uid = OLD.book_uid);
    INSERT INTO books_fts (rowid, title, subtitle, author, publisher, isbn, description, path)
    SELECT
        br.id, br.title, br.subtitle, br.author, br.publisher, br.isbn,
        br.description,
        (SELECT b.path FROM books b WHERE b.book_uid = br.uid
         ORDER BY b.available DESC, b.id LIMIT 1)
    FROM book_records br
    WHERE br.uid = OLD.book_uid;
END;

INSERT INTO books_fts (rowid, title, subtitle, author, publisher, isbn, description, path)
SELECT
    br.id, br.title, br.subtitle, br.author, br.publisher, br.isbn,
    br.description,
    (SELECT b.path FROM books b WHERE b.book_uid = br.uid
     ORDER BY b.available DESC, b.id LIMIT 1)
FROM book_records br
WHERE NOT EXISTS (SELECT 1 FROM books_fts f WHERE f.rowid = br.id);
