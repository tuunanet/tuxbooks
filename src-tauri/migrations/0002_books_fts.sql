-- Full-text search infrastructure over `books` (SQLite FTS5, external-content table).
-- The search feature itself is not built yet; this keeps the index in sync from day one
-- so that enabling search later does not require a backfill of existing libraries.

CREATE VIRTUAL TABLE books_fts USING fts5(
    title,
    subtitle,
    author,
    description,
    content='books',
    content_rowid='id'
);

CREATE TRIGGER books_fts_ai AFTER INSERT ON books BEGIN
    INSERT INTO books_fts(rowid, title, subtitle, author, description)
    VALUES (new.id, new.title, new.subtitle, new.author, new.description);
END;

CREATE TRIGGER books_fts_ad AFTER DELETE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, title, subtitle, author, description)
    VALUES ('delete', old.id, old.title, old.subtitle, old.author, old.description);
END;

CREATE TRIGGER books_fts_au AFTER UPDATE OF title, subtitle, author, description ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, title, subtitle, author, description)
    VALUES ('delete', old.id, old.title, old.subtitle, old.author, old.description);
    INSERT INTO books_fts(rowid, title, subtitle, author, description)
    VALUES (new.id, new.title, new.subtitle, new.author, new.description);
END;
