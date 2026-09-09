-- Milestone 5 (search): widen the full-text index to every library-search
-- field — publisher, isbn, and the file path (the default tokenizer splits
-- on '/' and '.', so path tokens already cover the bare file name).
-- External-content FTS5 tables cannot be altered in place, so the table and
-- its triggers are recreated; 'rebuild' re-reads every existing books row,
-- which is why no backfill step is needed.

DROP TRIGGER books_fts_au;
DROP TRIGGER books_fts_ad;
DROP TRIGGER books_fts_ai;
DROP TABLE books_fts;

CREATE VIRTUAL TABLE books_fts USING fts5(
    title,
    subtitle,
    author,
    publisher,
    isbn,
    description,
    path,
    content='books',
    content_rowid='id'
);

CREATE TRIGGER books_fts_ai AFTER INSERT ON books BEGIN
    INSERT INTO books_fts(rowid, title, subtitle, author, publisher, isbn, description, path)
    VALUES (new.id, new.title, new.subtitle, new.author, new.publisher, new.isbn, new.description, new.path);
END;

CREATE TRIGGER books_fts_ad AFTER DELETE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, title, subtitle, author, publisher, isbn, description, path)
    VALUES ('delete', old.id, old.title, old.subtitle, old.author, old.publisher, old.isbn, old.description, old.path);
END;

CREATE TRIGGER books_fts_au AFTER UPDATE OF title, subtitle, author, publisher, isbn, description, path ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, title, subtitle, author, publisher, isbn, description, path)
    VALUES ('delete', old.id, old.title, old.subtitle, old.author, old.publisher, old.isbn, old.description, old.path);
    INSERT INTO books_fts(rowid, title, subtitle, author, publisher, isbn, description, path)
    VALUES (new.id, new.title, new.subtitle, new.author, new.publisher, new.isbn, new.description, new.path);
END;

INSERT INTO books_fts(books_fts) VALUES ('rebuild');
