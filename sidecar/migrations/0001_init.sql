-- Initial schema for the tuxbooks library database.
-- See docs/database.md for the data model rationale.

PRAGMA foreign_keys = ON;

CREATE TABLE books (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    path           TEXT    NOT NULL UNIQUE,
    title          TEXT    NOT NULL,
    subtitle       TEXT,
    author         TEXT,
    publisher      TEXT,
    language       TEXT,
    isbn           TEXT,
    description    TEXT,
    cover_path     TEXT,
    added_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    modified_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_opened_at TEXT,
    CHECK (length(trim(title)) > 0)
);

CREATE TABLE collections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE book_collections (
    book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    added_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (book_id, collection_id)
);

CREATE TABLE reading_progress (
    book_id           INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    chapter_href      TEXT,
    character_offset  INTEGER,
    progress_percent  REAL CHECK (progress_percent IS NULL OR (progress_percent BETWEEN 0 AND 100)),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_books_author ON books(author);
CREATE INDEX idx_book_collections_collection ON book_collections(collection_id);
