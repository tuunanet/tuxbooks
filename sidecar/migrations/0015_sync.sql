-- Cloud-folder sync (docs/SYNC.md, ADR 0013).
--
-- The catalog stays local and path-keyed. This migration adds the parts that
-- let user-authored state cross machines:
--
--   * portable ids for annotations and collections;
--   * a book identity binding (book row -> shared uuid) plus content-hash
--     aliases, so a rewritten file keeps its identity;
--   * dirty markers written by triggers on every user-state change, including
--     the full row snapshot at change time (a later remote projection must not
--     erase an edit the sync worker has not drained yet);
--   * the materialized shared state (entities + per-field clocks), tombstones,
--     trash, conflicts, issues, and remote-file bookkeeping.
--
-- Triggers that hang off a book or collection check that the parent still
-- exists. Unwatching a folder or deleting a book cascades rows away; that is a
-- local disappearance, not a shared delete (SYNC.md "Local disappearance").

CREATE TABLE sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per entity with pending local state. `op` is the latest intent:
-- an update followed by a delete collapses to delete, and a delete followed by
-- a restore collapses to upsert. `old_json`/`new_json` are canonical snapshots
-- captured by the trigger, never re-read later.
CREATE TABLE sync_dirty (
    kind       TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    op         TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
    old_json   TEXT,
    new_json   TEXT,
    changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (kind, entity_key)
);

CREATE TABLE sync_state_entities (
    kind          TEXT NOT NULL,
    entity_uid    TEXT NOT NULL,
    book_uid      TEXT,
    -- Entity-level clock for progress/membership; field-level kinds leave it
    -- at zero and use sync_state_fields.
    hlc_wall      INTEGER NOT NULL DEFAULT 0,
    hlc_counter   INTEGER NOT NULL DEFAULT 0,
    hlc_device    TEXT NOT NULL DEFAULT '',
    deleted       INTEGER NOT NULL DEFAULT 0,
    deleted_wall  INTEGER,
    deleted_count INTEGER,
    deleted_dev   TEXT,
    restored_wall INTEGER,
    restored_count INTEGER,
    restored_dev  TEXT,
    PRIMARY KEY (kind, entity_uid)
);
CREATE INDEX sync_state_entities_book ON sync_state_entities(book_uid);

-- Per-field last-writer-wins clocks. `value_json` is the JSON encoding of the
-- field value ("null" is a real value: an explicitly cleared field).
CREATE TABLE sync_state_fields (
    kind          TEXT NOT NULL,
    entity_uid    TEXT NOT NULL,
    field         TEXT NOT NULL,
    value_json    TEXT NOT NULL,
    hlc_wall      INTEGER NOT NULL,
    hlc_counter   INTEGER NOT NULL,
    hlc_device    TEXT NOT NULL,
    PRIMARY KEY (kind, entity_uid, field)
);

-- Content hash -> shared book id. The hash is a discovery key only; the uuid
-- survives rewrites. An alias conflict resolves to the lexicographically
-- smallest uuid (deterministic on every device).
CREATE TABLE sync_book_aliases (
    content_hash TEXT PRIMARY KEY,
    book_uid     TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX sync_book_aliases_uid ON sync_book_aliases(book_uid);

CREATE TABLE sync_book_bindings (
    book_id      INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    book_uid     TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    hashed_size  INTEGER NOT NULL,
    hashed_mtime INTEGER NOT NULL,
    bound_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX sync_book_bindings_uid ON sync_book_bindings(book_uid);

-- Identity merges: two devices can independently create a uuid for the same
-- content before they meet. Every op resolves through this table, so replay
-- order cannot resurrect the losing id.
CREATE TABLE sync_book_merges (
    loser  TEXT PRIMARY KEY,
    winner TEXT NOT NULL
);

-- Collection ids can collide by name across devices (collections.name is
-- UNIQUE locally, and the same name means the same shelf to the user).
CREATE TABLE sync_entity_merges (
    kind   TEXT NOT NULL,
    loser  TEXT NOT NULL,
    winner TEXT NOT NULL,
    PRIMARY KEY (kind, loser)
);

CREATE TABLE sync_ops (
    op_id        TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL,
    hlc_wall     INTEGER NOT NULL,
    hlc_counter  INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    entity_uid   TEXT NOT NULL,
    book_uid     TEXT,
    deleted      INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL,
    file_name    TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX sync_ops_hlc ON sync_ops(hlc_wall, hlc_counter);

CREATE TABLE sync_applied_ops (
    op_id      TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL,
    file_name  TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sync_remote_files (
    relative_path TEXT PRIMARY KEY,
    size          INTEGER NOT NULL,
    mtime         INTEGER NOT NULL,
    failures      INTEGER NOT NULL DEFAULT 0,
    processed_at  TEXT
);

CREATE TABLE sync_issues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_key   TEXT NOT NULL,
    kind        TEXT NOT NULL,
    detail      TEXT NOT NULL,
    file_name   TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at TEXT
);
CREATE INDEX sync_issues_open ON sync_issues(resolved_at);

CREATE TABLE sync_conflicts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    entity_uid TEXT NOT NULL,
    field      TEXT NOT NULL,
    winner_json TEXT NOT NULL,
    loser_json  TEXT NOT NULL,
    winner_wall INTEGER NOT NULL,
    winner_count INTEGER NOT NULL,
    winner_dev   TEXT NOT NULL,
    loser_wall   INTEGER NOT NULL,
    loser_count  INTEGER NOT NULL,
    loser_dev    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sync_trash (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    entity_uid   TEXT NOT NULL,
    book_uid     TEXT,
    prior_json   TEXT NOT NULL,
    deleted_wall INTEGER NOT NULL,
    deleted_count INTEGER NOT NULL,
    deleted_dev   TEXT NOT NULL,
    deleted_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    restored_at  TEXT,
    UNIQUE (kind, entity_uid, deleted_wall, deleted_count, deleted_dev)
);

-- Portable ids. Existing rows get one now; new rows are filled by the sync
-- worker if the insert path did not provide one. The unique index tolerates
-- multiple NULLs, so a row created while sync is off is never a constraint
-- error.
ALTER TABLE annotations ADD COLUMN sync_uid TEXT;
UPDATE annotations SET sync_uid = lower(hex(randomblob(16))) WHERE sync_uid IS NULL;
CREATE UNIQUE INDEX idx_annotations_sync_uid ON annotations(sync_uid);

ALTER TABLE collections ADD COLUMN sync_uid TEXT;
UPDATE collections SET sync_uid = lower(hex(randomblob(16))) WHERE sync_uid IS NULL;
CREATE UNIQUE INDEX idx_collections_sync_uid ON collections(sync_uid);

-- Canonical metadata snapshot: the override row plus the user-owned author
-- and subject lists. `authors`/`subjects` are NULL when the list follows the
-- source file, so a machine with a different copy of the file does not fight
-- over it.
CREATE VIEW sync_metadata_snapshot AS
SELECT
    o.book_id AS book_id,
    json_object(
        'title', o.title,
        'subtitle', o.subtitle,
        'publisher', o.publisher,
        'language', o.language,
        'isbn', o.isbn,
        'description', o.description,
        'publication_date', o.publication_date,
        'series', o.series,
        'series_index', o.series_index,
        'cover_path', o.cover_path,
        'authors_customized',
            CASE WHEN o.authors_customized = 1 THEN json('true') ELSE json('false') END,
        'authors',
            CASE WHEN o.authors_customized = 1 THEN
                (SELECT json_group_array(name) FROM (
                    SELECT a.name AS name
                    FROM book_authors ba
                    JOIN authors a ON a.id = ba.author_id
                    WHERE ba.book_id = o.book_id
                    ORDER BY ba.position, a.name
                ))
            ELSE NULL END,
        'subjects_customized',
            CASE WHEN o.subjects_customized = 1 THEN json('true') ELSE json('false') END,
        'subjects',
            CASE WHEN o.subjects_customized = 1 THEN
                (SELECT json_group_array(name) FROM (
                    SELECT s.name AS name
                    FROM book_subjects bs
                    JOIN subjects s ON s.id = bs.subject_id
                    WHERE bs.book_id = o.book_id
                    ORDER BY s.name
                ))
            ELSE NULL END
    ) AS snapshot_json
FROM book_metadata_overrides o;

-- ---------------------------------------------------------------------------
-- Dirty markers
-- ---------------------------------------------------------------------------

CREATE TRIGGER sync_annotations_ai AFTER INSERT ON annotations
WHEN EXISTS (SELECT 1 FROM books WHERE id = NEW.book_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'annotation',
        CAST(NEW.id AS TEXT),
        'upsert',
        NULL,
        json_object(
            'book_id', NEW.book_id,
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
WHEN EXISTS (SELECT 1 FROM books WHERE id = NEW.book_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'annotation',
        CAST(NEW.id AS TEXT),
        'upsert',
        NULL,
        json_object(
            'book_id', NEW.book_id,
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
WHEN EXISTS (SELECT 1 FROM books WHERE id = OLD.book_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'annotation',
        CAST(OLD.id AS TEXT),
        'delete',
        json_object(
            'book_id', OLD.book_id,
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

CREATE TRIGGER sync_collections_ai AFTER INSERT ON collections
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'collection',
        CAST(NEW.id AS TEXT),
        'upsert',
        NULL,
        json_object('sync_uid', NEW.sync_uid, 'name', NEW.name, 'created_at', NEW.created_at)
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_collections_au AFTER UPDATE ON collections
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'collection',
        CAST(NEW.id AS TEXT),
        'upsert',
        NULL,
        json_object('sync_uid', NEW.sync_uid, 'name', NEW.name, 'created_at', NEW.created_at)
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_collections_ad AFTER DELETE ON collections
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'collection',
        CAST(OLD.id AS TEXT),
        'delete',
        json_object('sync_uid', OLD.sync_uid, 'name', OLD.name, 'created_at', OLD.created_at),
        NULL
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'delete',
        old_json = excluded.old_json,
        new_json = NULL,
        changed_at = excluded.changed_at;
END;

-- Membership rows disappear when either parent disappears. Those cascades are
-- local disappearances, not shared deletes.
CREATE TRIGGER sync_book_collections_ai AFTER INSERT ON book_collections
WHEN EXISTS (SELECT 1 FROM books WHERE id = NEW.book_id)
 AND EXISTS (SELECT 1 FROM collections WHERE id = NEW.collection_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'membership',
        CAST(NEW.book_id AS TEXT) || ':' || CAST(NEW.collection_id AS TEXT),
        'upsert',
        NULL,
        json_object(
            'book_id', NEW.book_id,
            'collection_id', NEW.collection_id,
            'present', json('true'),
            'added_at', NEW.added_at
        )
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_collections_ad AFTER DELETE ON book_collections
WHEN EXISTS (SELECT 1 FROM books WHERE id = OLD.book_id)
 AND EXISTS (SELECT 1 FROM collections WHERE id = OLD.collection_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'membership',
        CAST(OLD.book_id AS TEXT) || ':' || CAST(OLD.collection_id AS TEXT),
        'delete',
        json_object(
            'book_id', OLD.book_id,
            'collection_id', OLD.collection_id,
            'present', json('false'),
            'added_at', OLD.added_at
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
WHEN EXISTS (SELECT 1 FROM books WHERE id = NEW.book_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'progress',
        CAST(NEW.book_id AS TEXT),
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
WHEN EXISTS (SELECT 1 FROM books WHERE id = NEW.book_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'progress',
        CAST(NEW.book_id AS TEXT),
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
WHEN EXISTS (SELECT 1 FROM books WHERE id = OLD.book_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'progress',
        CAST(OLD.book_id AS TEXT),
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

CREATE TRIGGER sync_books_opened_au AFTER UPDATE OF last_opened_at ON books
WHEN OLD.last_opened_at IS NOT NEW.last_opened_at
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'opened',
        CAST(NEW.id AS TEXT),
        'upsert',
        NULL,
        json_object('last_opened_at', NEW.last_opened_at)
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_metadata_ai AFTER INSERT ON book_metadata_overrides
WHEN EXISTS (SELECT 1 FROM books WHERE id = NEW.book_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', CAST(NEW.book_id AS TEXT), 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_id = NEW.book_id
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_metadata_au AFTER UPDATE ON book_metadata_overrides
WHEN EXISTS (SELECT 1 FROM books WHERE id = NEW.book_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', CAST(NEW.book_id AS TEXT), 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_id = NEW.book_id
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

-- Reset deletes the override row; the canonical state becomes all NULL.
CREATE TRIGGER sync_metadata_ad AFTER DELETE ON book_metadata_overrides
WHEN EXISTS (SELECT 1 FROM books WHERE id = OLD.book_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'metadata',
        CAST(OLD.book_id AS TEXT),
        'upsert',
        NULL,
        json_object(
            'title', NULL,
            'subtitle', NULL,
            'publisher', NULL,
            'language', NULL,
            'isbn', NULL,
            'description', NULL,
            'publication_date', NULL,
            'series', NULL,
            'series_index', NULL,
            'cover_path', NULL,
            'authors_customized', json('false'),
            'authors', NULL,
            'subjects_customized', json('false'),
            'subjects', NULL
        )
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_authors_ai AFTER INSERT ON book_authors
WHEN COALESCE((SELECT authors_customized FROM book_metadata_overrides WHERE book_id = NEW.book_id), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', CAST(NEW.book_id AS TEXT), 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_id = NEW.book_id
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_authors_au AFTER UPDATE ON book_authors
WHEN COALESCE((SELECT authors_customized FROM book_metadata_overrides WHERE book_id = NEW.book_id), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', CAST(NEW.book_id AS TEXT), 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_id = NEW.book_id
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_authors_ad AFTER DELETE ON book_authors
WHEN COALESCE((SELECT authors_customized FROM book_metadata_overrides WHERE book_id = OLD.book_id), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', CAST(OLD.book_id AS TEXT), 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_id = OLD.book_id
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_subjects_ai AFTER INSERT ON book_subjects
WHEN COALESCE((SELECT subjects_customized FROM book_metadata_overrides WHERE book_id = NEW.book_id), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', CAST(NEW.book_id AS TEXT), 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_id = NEW.book_id
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_subjects_au AFTER UPDATE ON book_subjects
WHEN COALESCE((SELECT subjects_customized FROM book_metadata_overrides WHERE book_id = NEW.book_id), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', CAST(NEW.book_id AS TEXT), 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_id = NEW.book_id
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_subjects_ad AFTER DELETE ON book_subjects
WHEN COALESCE((SELECT subjects_customized FROM book_metadata_overrides WHERE book_id = OLD.book_id), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', CAST(OLD.book_id AS TEXT), 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_id = OLD.book_id
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;
