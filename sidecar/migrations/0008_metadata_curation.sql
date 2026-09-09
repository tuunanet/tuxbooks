-- Metadata and library curation (milestone 7).
--
-- Three-layer model:
--   1. `book_source_metadata`  — file truth, refreshed by the importer on
--      every (re)import so the original values survive user curation.
--   2. `book_metadata_overrides` — user truth. NULL = inherit the source
--      value; empty string = explicitly cleared. Minimal by construction:
--      the edit service stores an override only where a field differs from
--      the source.
--   3. `books` columns — the effective view (override if present, else
--      source) that every reader path already consumes; FTS5 triggers keep
--      the search index in sync automatically.
--
-- Source files are never rewritten; curation is database-only.

-- Normalized entities (ROADMAP milestone 7): multiple authors, multiple
-- subjects, series. Relationships are rows, never opaque strings. The
-- legacy `books.author` column becomes a maintained display projection of
-- the author list (joined with ", ") so FTS and list views keep working.
CREATE TABLE authors (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE book_authors (
    book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (book_id, author_id)
);

CREATE TABLE subjects (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE book_subjects (
    book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, subject_id)
);

CREATE TABLE series (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

-- Effective series membership lives on the book; the name resolves through
-- the normalized `series` table.
ALTER TABLE books ADD COLUMN publication_date TEXT;
ALTER TABLE books ADD COLUMN series_id INTEGER REFERENCES series(id) ON DELETE SET NULL;
ALTER TABLE books ADD COLUMN series_index REAL;

-- Bibliographic truth of the source file (the importer's own view of the
-- last parse). `authors`/`subjects` are JSON arrays so a reset can restore
-- even a list the user has since replaced.
CREATE TABLE book_source_metadata (
    book_id          INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    subtitle         TEXT,
    publisher        TEXT,
    language         TEXT,
    isbn             TEXT,
    description      TEXT,
    publication_date TEXT,
    series           TEXT,
    series_index     REAL,
    cover_path       TEXT,
    authors          TEXT,
    subjects         TEXT
);

-- User overrides. `authors_customized`/`subjects_customized` gate whether a
-- re-import may replace the normalized lists (0 = follow the file,
-- 1 = the user owns the list). `cover_path` overrides the extracted cover.
CREATE TABLE book_metadata_overrides (
    book_id             INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    title               TEXT,
    subtitle            TEXT,
    publisher           TEXT,
    language            TEXT,
    isbn                TEXT,
    description         TEXT,
    publication_date    TEXT,
    series              TEXT,
    series_index        REAL,
    cover_path          TEXT,
    authors_customized  INTEGER NOT NULL DEFAULT 0,
    subjects_customized INTEGER NOT NULL DEFAULT 0
);

-- Backfill: pre-curation rows hold source values only (no overrides existed),
-- so the snapshot is a plain copy. The flat author string becomes the single
-- normalized author row, reproducing the same display string on re-join.
INSERT INTO book_source_metadata (book_id, title, subtitle, publisher, language, isbn,
                                  description, publication_date, series, series_index,
                                  cover_path, authors, subjects)
SELECT id, title, subtitle, publisher, language, isbn, description,
       NULL, NULL, NULL, cover_path,
       CASE WHEN author IS NULL THEN NULL ELSE json_array(author) END,
       json_array()
FROM books;

INSERT INTO book_metadata_overrides (book_id) SELECT id FROM books;

INSERT INTO authors (name)
SELECT DISTINCT author FROM books WHERE author IS NOT NULL AND trim(author) != '';

INSERT INTO book_authors (book_id, author_id, position)
SELECT b.id, a.id, 0 FROM books b
JOIN authors a ON a.name = trim(b.author)
WHERE b.author IS NOT NULL AND trim(b.author) != '';
