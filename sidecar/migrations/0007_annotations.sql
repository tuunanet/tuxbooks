-- Reading annotations (milestone 6): bookmarks, highlights, and attached notes.
-- One row per annotation; a note is attached 1:1 through `note`.
-- Locators are stable, format-specific values — never UI coordinates:
-- EPUB carries a canonical CFI (plus its spine href for grouping), PDF a
-- 1-based page number and an optional page-local anchor fraction (0..1).
-- Highlight geometry is a JSON array of rects normalized to page space,
-- so highlights survive zoom, resize, and re-layout.
CREATE TABLE annotations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL CHECK (kind IN ('bookmark', 'highlight')),
    cfi           TEXT,
    chapter_href  TEXT,
    page_number   INTEGER CHECK (page_number IS NULL OR page_number >= 1),
    page_fraction REAL    CHECK (page_fraction IS NULL OR (page_fraction BETWEEN 0 AND 1)),
    text          TEXT,
    color         TEXT,
    geometry      TEXT,
    note          TEXT,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    modified_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_annotations_book ON annotations(book_id, kind);
