-- Durable reading state (ADR 0014, ticket tuxbooks-ip6.2).
--
-- Reading progress and annotations stop belonging to a file row and start
-- belonging to the durable book record from 0017. The public numeric book id
-- becomes `book_records.id`; a file row is only a location that the reader
-- resolves from the book.
--
-- This migration:
--   * gives `book_records` a stable INTEGER PRIMARY KEY;
--   * re-keys `reading_progress` and `annotations` by `book_uid`;
--   * unions state that several file rows already shared under one identity
--     (newest progress wins, annotations are kept together) and records the
--     merge as a visible issue;
--   * removes the 0017 trigger that deleted the durable book when the last
--     file row disappeared, which is the behaviour this ticket flips;
--   * rebuilds the sync capture triggers for the new keys.
--
-- Collections, metadata overrides, and last-opened stay keyed by the file row
-- in this slice; ticket .4 moves them. A forward-only migration is required:
-- a rolled-back app fails closed on the newer schema version.

-- ---------------------------------------------------------------------------
-- Durable book records gain the stable public id
-- ---------------------------------------------------------------------------

CREATE TABLE book_records_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    uid              TEXT NOT NULL UNIQUE,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    title            TEXT,
    subtitle         TEXT,
    author           TEXT,
    publisher        TEXT,
    language         TEXT,
    isbn             TEXT,
    description      TEXT,
    publication_date TEXT,
    series           TEXT,
    series_index     REAL,
    cover_path       TEXT,
    last_opened_at   TEXT,
    progress_percent REAL,
    annotation_count INTEGER NOT NULL DEFAULT 0,
    metadata_state   TEXT NOT NULL DEFAULT 'waiting_for_file'
        CHECK (metadata_state IN ('available', 'waiting_for_file'))
);

INSERT INTO book_records_new (
    id, uid, created_at, title, subtitle, author, publisher, language, isbn,
    description, publication_date, series, series_index, cover_path,
    last_opened_at, progress_percent, annotation_count, metadata_state
)
SELECT
    ROW_NUMBER() OVER (ORDER BY created_at, uid),
    uid, created_at, title, subtitle, author, publisher, language, isbn,
    description, publication_date, series, series_index, cover_path,
    last_opened_at, progress_percent, annotation_count, metadata_state
FROM book_records;

-- The 0017 triggers on `books` reference `book_records` by name; drop them
-- while the table is rebuilt and recreate them against the new schema.
DROP TRIGGER IF EXISTS book_records_ai;
DROP TRIGGER IF EXISTS book_records_au;
-- 0017 deleted the durable record when its last file row went, to preserve the
-- old destructive behaviour. Remove and Unwatch now end a membership only.
DROP TRIGGER IF EXISTS book_records_ad;

DROP TABLE book_records;
ALTER TABLE book_records_new RENAME TO book_records;

-- ---------------------------------------------------------------------------
-- Durable book records keep their book-row snapshot in step
-- ---------------------------------------------------------------------------

CREATE TRIGGER book_records_ai AFTER INSERT ON books
WHEN NEW.book_uid IS NOT NULL
BEGIN
    INSERT INTO book_records (
        uid, title, subtitle, author, publisher, language, isbn, description,
        publication_date, cover_path, last_opened_at, metadata_state
    )
    VALUES (
        NEW.book_uid, NEW.title, NEW.subtitle, NEW.author, NEW.publisher,
        NEW.language, NEW.isbn, NEW.description, NEW.publication_date,
        NEW.cover_path, NEW.last_opened_at, 'available'
    )
    ON CONFLICT(uid) DO NOTHING;
END;

CREATE TRIGGER book_records_au
AFTER UPDATE OF
    title, subtitle, author, publisher, language, isbn, description,
    publication_date, cover_path, last_opened_at
ON books
WHEN NEW.book_uid IS NOT NULL
BEGIN
    UPDATE book_records
    SET title = NEW.title,
        subtitle = NEW.subtitle,
        author = NEW.author,
        publisher = NEW.publisher,
        language = NEW.language,
        isbn = NEW.isbn,
        description = NEW.description,
        publication_date = NEW.publication_date,
        cover_path = NEW.cover_path,
        last_opened_at = NEW.last_opened_at,
        metadata_state = 'available'
    WHERE uid = NEW.book_uid;
END;

-- ---------------------------------------------------------------------------
-- Union duplicate state that 0017 could identify but not merge
-- ---------------------------------------------------------------------------
--
-- Several file rows can already share one durable identity after 0017. Their
-- progress and annotation rows still hang off the individual file rows. Record
-- the merge before re-keying collapses the rows: the visible issue says what
-- happened, and names the ambiguous case where two progress saves share their
-- timestamp.

INSERT INTO migration_issues (issue_key, kind, detail, book_uid)
SELECT
    'duplicate-progress:' || b.book_uid,
    'duplicate_state_merged',
    'This book had more than one saved reading position. The newest one was kept'
        || CASE
            WHEN COUNT(DISTINCT rp.updated_at) = 1
            THEN '; the timestamps tied, so which one is newest is ambiguous.'
            ELSE '.'
        END,
    b.book_uid
FROM reading_progress rp
JOIN books b ON b.id = rp.book_id
WHERE b.book_uid IS NOT NULL
GROUP BY b.book_uid
HAVING COUNT(*) > 1;

INSERT INTO migration_issues (issue_key, kind, detail, book_uid)
SELECT
    'duplicate-annotations:' || b.book_uid,
    'duplicate_state_merged',
    'These copies of one book each had annotations. All annotations were kept; '
        || 'duplicate highlights are possible.',
    b.book_uid
FROM annotations a
JOIN books b ON b.id = a.book_id
WHERE b.book_uid IS NOT NULL
GROUP BY b.book_uid
HAVING COUNT(DISTINCT a.book_id) > 1;

-- ---------------------------------------------------------------------------
-- Re-key reading progress by durable book
-- ---------------------------------------------------------------------------

CREATE TABLE reading_progress_new (
    book_uid          TEXT NOT NULL PRIMARY KEY REFERENCES book_records(uid) ON DELETE CASCADE,
    chapter_href      TEXT,
    character_offset  INTEGER,
    progress_percent  REAL CHECK (progress_percent IS NULL OR (progress_percent BETWEEN 0 AND 100)),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cfi               TEXT,
    page_number       INTEGER,
    scroll_offset     REAL,
    locator           TEXT,
    progression       REAL CHECK (progression IS NULL OR (progression BETWEEN 0 AND 1)),
    locations         TEXT,
    engine            TEXT,
    schema_version    INTEGER
);

-- Oldest first, so the newest row is the last write for a uid. A tie keeps
-- the highest file-row id, which is deterministic.
INSERT OR REPLACE INTO reading_progress_new (
    book_uid, chapter_href, character_offset, progress_percent, updated_at,
    cfi, page_number, scroll_offset, locator, progression, locations, engine,
    schema_version
)
SELECT
    b.book_uid, rp.chapter_href, rp.character_offset, rp.progress_percent,
    rp.updated_at, rp.cfi, rp.page_number, rp.scroll_offset, rp.locator,
    rp.progression, rp.locations, rp.engine, rp.schema_version
FROM reading_progress rp
JOIN books b ON b.id = rp.book_id
WHERE b.book_uid IS NOT NULL
ORDER BY rp.updated_at ASC, rp.book_id ASC;

DROP TABLE reading_progress;
ALTER TABLE reading_progress_new RENAME TO reading_progress;

-- ---------------------------------------------------------------------------
-- Re-key annotations by durable book
-- ---------------------------------------------------------------------------

CREATE TABLE annotations_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    book_uid      TEXT    NOT NULL REFERENCES book_records(uid) ON DELETE CASCADE,
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
    modified_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    sync_uid      TEXT,
    label         TEXT
);

INSERT INTO annotations_new (
    id, book_uid, kind, cfi, chapter_href, page_number, page_fraction, text,
    color, geometry, note, created_at, modified_at, sync_uid, label
)
SELECT
    a.id, b.book_uid, a.kind, a.cfi, a.chapter_href, a.page_number,
    a.page_fraction, a.text, a.color, a.geometry, a.note, a.created_at,
    a.modified_at, a.sync_uid, a.label
FROM annotations a
JOIN books b ON b.id = a.book_id
WHERE b.book_uid IS NOT NULL;

DROP TABLE annotations;
ALTER TABLE annotations_new RENAME TO annotations;

CREATE INDEX idx_annotations_book ON annotations(book_uid, kind);
CREATE UNIQUE INDEX idx_annotations_sync_uid ON annotations(sync_uid);

-- ---------------------------------------------------------------------------
-- Sync capture triggers follow the durable key
-- ---------------------------------------------------------------------------
--
-- The wire contract is unchanged (`book_id` in the snapshot is the public
-- durable id). Only the local key moved from the file row to the book.

CREATE TRIGGER sync_annotations_ai AFTER INSERT ON annotations
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = NEW.book_uid)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'annotation',
        CAST(NEW.id AS TEXT),
        'upsert',
        NULL,
        json_object(
            'book_id', (SELECT id FROM book_records WHERE uid = NEW.book_uid),
            'sync_uid', NEW.sync_uid,
            'kind', NEW.kind,
            'cfi', NEW.cfi,
            'chapter_href', NEW.chapter_href,
            'page_number', NEW.page_number,
            'page_fraction', NEW.page_fraction,
            'text', NEW.text,
            'color', NEW.color,
            'geometry', NEW.geometry,
            'note', NEW.note,
            'label', NEW.label,
            'created_at', NEW.created_at
        )
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_annotations_au AFTER UPDATE ON annotations
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = NEW.book_uid)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'annotation',
        CAST(NEW.id AS TEXT),
        'upsert',
        NULL,
        json_object(
            'book_id', (SELECT id FROM book_records WHERE uid = NEW.book_uid),
            'sync_uid', NEW.sync_uid,
            'kind', NEW.kind,
            'cfi', NEW.cfi,
            'chapter_href', NEW.chapter_href,
            'page_number', NEW.page_number,
            'page_fraction', NEW.page_fraction,
            'text', NEW.text,
            'color', NEW.color,
            'geometry', NEW.geometry,
            'note', NEW.note,
            'label', NEW.label,
            'created_at', NEW.created_at
        )
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_annotations_ad AFTER DELETE ON annotations
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = OLD.book_uid)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'annotation',
        CAST(OLD.id AS TEXT),
        'delete',
        json_object(
            'book_id', (SELECT id FROM book_records WHERE uid = OLD.book_uid),
            'sync_uid', OLD.sync_uid,
            'kind', OLD.kind,
            'cfi', OLD.cfi,
            'chapter_href', OLD.chapter_href,
            'page_number', OLD.page_number,
            'page_fraction', OLD.page_fraction,
            'text', OLD.text,
            'color', OLD.color,
            'geometry', OLD.geometry,
            'note', OLD.note,
            'label', OLD.label,
            'created_at', OLD.created_at
        ),
        NULL
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'delete',
        old_json = excluded.old_json,
        new_json = NULL,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_progress_ai AFTER INSERT ON reading_progress
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = NEW.book_uid)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'progress',
        NEW.book_uid,
        'upsert',
        NULL,
        json_object(
            'chapter_href', NEW.chapter_href,
            'cfi', NEW.cfi,
            'character_offset', NEW.character_offset,
            'page_number', NEW.page_number,
            'scroll_offset', NEW.scroll_offset,
            'progress_percent', NEW.progress_percent,
            'locator', NEW.locator,
            'progression', NEW.progression,
            'locations', NEW.locations,
            'engine', NEW.engine,
            'schema_version', NEW.schema_version
        )
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_progress_au AFTER UPDATE ON reading_progress
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = NEW.book_uid)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'progress',
        NEW.book_uid,
        'upsert',
        NULL,
        json_object(
            'chapter_href', NEW.chapter_href,
            'cfi', NEW.cfi,
            'character_offset', NEW.character_offset,
            'page_number', NEW.page_number,
            'scroll_offset', NEW.scroll_offset,
            'progress_percent', NEW.progress_percent,
            'locator', NEW.locator,
            'progression', NEW.progression,
            'locations', NEW.locations,
            'engine', NEW.engine,
            'schema_version', NEW.schema_version
        )
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_progress_ad AFTER DELETE ON reading_progress
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = OLD.book_uid)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'progress',
        OLD.book_uid,
        'delete',
        json_object(
            'chapter_href', OLD.chapter_href,
            'cfi', OLD.cfi,
            'character_offset', OLD.character_offset,
            'page_number', OLD.page_number,
            'scroll_offset', OLD.scroll_offset,
            'progress_percent', OLD.progress_percent,
            'locator', OLD.locator,
            'progression', OLD.progression,
            'locations', OLD.locations,
            'engine', OLD.engine,
            'schema_version', OLD.schema_version
        ),
        NULL
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'delete',
        old_json = excluded.old_json,
        new_json = NULL,
        changed_at = excluded.changed_at;
END;
