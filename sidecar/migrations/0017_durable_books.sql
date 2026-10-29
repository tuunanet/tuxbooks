-- Durable book records (ADR 0014, epic tuxbooks-ip6).
--
-- A catalog row is about to become a *file* row: a location inside a watched
-- folder. The durable book record is the thing that owns identity and, in the
-- later slices, reading state. This migration is the forward-only foundation:
--
--   * `book_records` gives every book a stable 128-bit uuid and a small
--     metadata snapshot for books that currently have no file;
--   * `books.book_uid` binds each file row to its durable book (more than one
--     file may share one book, for duplicate copies or a move);
--   * `books.hash_state` is durable progress for the background hash pass, so
--     a restart resumes where it stopped and later destructive actions can
--     wait on an unknown hash;
--   * `migration_issues` records identity merges so the upgrade is visible
--     instead of silent.
--
-- Existing user-state tables stay keyed by `books.id` in this slice. The
-- tickets that make state survive unwatch/move re-key them; moving that work
-- here would flip user-visible behaviour before it is designed. The metadata
-- snapshot on the durable record is only authoritative for books with no file
-- (state recovered from the sync mirror).
--
-- A pre-migration backup is taken by the startup path, not here. See
-- `db::connection` and docs/DATABASE.md.

CREATE TABLE book_records (
    uid              TEXT PRIMARY KEY,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Snapshot used when the book has no file row (Reading history). A book
    -- with a file gets its effective metadata from that row.
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
    -- 'available' once metadata exists (a file or the sync mirror supplied
    -- it); 'waiting_for_file' for a recovered identity whose file, and whose
    -- metadata, are still missing.
    metadata_state   TEXT NOT NULL DEFAULT 'waiting_for_file'
        CHECK (metadata_state IN ('available', 'waiting_for_file'))
);

ALTER TABLE books ADD COLUMN book_uid TEXT;
ALTER TABLE books ADD COLUMN hash_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (hash_state IN ('pending', 'hashed', 'failed'));

CREATE INDEX idx_books_book_uid ON books(book_uid);

-- ---------------------------------------------------------------------------
-- Backfill identity
-- ---------------------------------------------------------------------------

-- A sync binding already owns the shared uuid; reuse it so the upgrade does
-- not re-baseline existing sync state (ADR 0014 D3). Every other row gets a
-- fresh uuid.
UPDATE books
SET book_uid = (
    SELECT s.book_uid FROM sync_book_bindings s WHERE s.book_id = books.id
)
WHERE id IN (SELECT book_id FROM sync_book_bindings);

UPDATE books
SET book_uid = lower(hex(randomblob(16)))
WHERE book_uid IS NULL;

-- A bound row already knows its content hash, unless the binding describes an
-- older version of the file (`rehash_pending` or a size/mtime mismatch). Those
-- rows stay pending so the background pass rehashes them even with sync off.
UPDATE books
SET hash_state = 'hashed'
WHERE rehash_pending = 0
  AND EXISTS (
      SELECT 1
      FROM sync_book_bindings s
      WHERE s.book_id = books.id
        AND s.hashed_size = books.file_size
        AND s.hashed_mtime = books.file_mtime
  );

-- One durable record per uuid. When several file rows share a uuid, the most
-- recently modified row supplies the metadata snapshot, the oldest added_at
-- supplies created_at, and last-opened is the latest of the copies.
INSERT INTO book_records (
    uid, created_at, title, subtitle, author, publisher, language, isbn,
    description, publication_date, cover_path, last_opened_at,
    progress_percent, annotation_count, metadata_state
)
SELECT
    r.book_uid,
    r.created_max,
    r.title,
    r.subtitle,
    r.author,
    r.publisher,
    r.language,
    r.isbn,
    r.description,
    r.publication_date,
    r.cover_path,
    r.last_opened_max,
    (
        SELECT rp.progress_percent
        FROM reading_progress rp
        JOIN books b ON b.id = rp.book_id
        WHERE b.book_uid = r.book_uid
        ORDER BY rp.updated_at DESC, rp.book_id
        LIMIT 1
    ),
    (
        SELECT COUNT(*)
        FROM annotations a
        JOIN books b ON b.id = a.book_id
        WHERE b.book_uid = r.book_uid
    ),
    'available'
FROM (
    SELECT
        b.*,
        MIN(b.added_at) OVER (PARTITION BY b.book_uid) AS created_max,
        MAX(b.last_opened_at) OVER (PARTITION BY b.book_uid) AS last_opened_max,
        ROW_NUMBER() OVER (
            PARTITION BY b.book_uid ORDER BY b.modified_at DESC, b.id DESC
        ) AS rn
    FROM books b
) r
WHERE r.rn = 1;

-- ---------------------------------------------------------------------------
-- Recover identity the sync mirror still holds for already-unwatched books
-- ---------------------------------------------------------------------------
--
-- The mirror (ADR 0013) keeps entities for a uuid after the local row is
-- gone. Materialize a durable record for every uuid the mirror still knows
-- that has no file, using whatever metadata survived. Progress and the
-- annotation count are snapshotted for Reading history; the mirror rows stay
-- in place as the merge cache, and projection fills the local user-state
-- tables when a file returns. State that never reached the mirror cannot be
-- recovered here.
INSERT INTO book_records (
    uid, created_at, title, subtitle, author, publisher, language, isbn,
    description, publication_date, series, series_index, cover_path,
    last_opened_at, progress_percent, annotation_count, metadata_state
)
SELECT
    u.uid,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    MAX(CASE WHEN m.field = 'title' THEN json_extract(m.value_json, '$') END),
    MAX(CASE WHEN m.field = 'subtitle' THEN json_extract(m.value_json, '$') END),
    MAX(CASE WHEN m.field = 'authors' THEN json_extract(m.value_json, '$[0]') END),
    MAX(CASE WHEN m.field = 'publisher' THEN json_extract(m.value_json, '$') END),
    MAX(CASE WHEN m.field = 'language' THEN json_extract(m.value_json, '$') END),
    MAX(CASE WHEN m.field = 'isbn' THEN json_extract(m.value_json, '$') END),
    MAX(CASE WHEN m.field = 'description' THEN json_extract(m.value_json, '$') END),
    MAX(CASE WHEN m.field = 'publication_date' THEN json_extract(m.value_json, '$') END),
    MAX(CASE WHEN m.field = 'series' THEN json_extract(m.value_json, '$') END),
    MAX(CASE WHEN m.field = 'series_index' THEN json_extract(m.value_json, '$') END),
    MAX(CASE WHEN m.field = 'cover_path' THEN json_extract(m.value_json, '$') END),
    (
        SELECT json_extract(o.value_json, '$')
        FROM sync_state_fields o
        WHERE o.kind = 'opened'
          AND o.entity_uid = u.uid
          AND o.field = 'last_opened_at'
        LIMIT 1
    ),
    (
        SELECT json_extract(p.value_json, '$')
        FROM sync_state_fields p
        WHERE p.kind = 'progress'
          AND p.entity_uid = u.uid
          AND p.field = 'progress_percent'
        LIMIT 1
    ),
    (
        SELECT COUNT(*)
        FROM sync_state_entities a
        WHERE a.kind = 'annotation'
          AND a.book_uid = u.uid
          AND a.deleted = 0
    ),
    CASE
        WHEN MAX(CASE
            WHEN m.field = 'title'
             AND json_extract(m.value_json, '$') IS NOT NULL
            THEN 1 ELSE 0 END) = 1
        THEN 'available'
        ELSE 'waiting_for_file'
    END
FROM (
    SELECT book_uid AS uid
    FROM sync_state_entities
    WHERE book_uid IS NOT NULL
    UNION
    SELECT book_uid AS uid
    FROM sync_book_aliases
) u
LEFT JOIN sync_state_fields m
    ON m.kind = 'metadata' AND m.entity_uid = u.uid
WHERE u.uid NOT IN (SELECT uid FROM book_records)
GROUP BY u.uid;

-- ---------------------------------------------------------------------------
-- Visible migration issues
-- ---------------------------------------------------------------------------

CREATE TABLE migration_issues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_key   TEXT NOT NULL,
    kind        TEXT NOT NULL,
    detail      TEXT NOT NULL,
    book_uid    TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at TEXT
);
CREATE INDEX migration_issues_open ON migration_issues(resolved_at);

-- Several file rows already shared a sync uuid before this upgrade. They now
-- share one durable book; say so instead of silently collapsing them.
INSERT INTO migration_issues (issue_key, kind, detail, book_uid)
SELECT
    'existing-duplicate:' || book_uid,
    'duplicate_identity',
    'These files already shared one book identity and now belong to one book: '
        || group_concat(path, ', ') || '.',
    book_uid
FROM books
GROUP BY book_uid
HAVING COUNT(*) > 1;

-- ---------------------------------------------------------------------------
-- Keep the durable snapshot in step with the file row
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

-- Until ticket .2 flips the destructive actions, removing the last file row
-- removes the book. A book that still has another file row keeps its record.
CREATE TRIGGER book_records_ad AFTER DELETE ON books
WHEN OLD.book_uid IS NOT NULL
BEGIN
    DELETE FROM book_records
    WHERE uid = OLD.book_uid
      AND NOT EXISTS (SELECT 1 FROM books WHERE book_uid = OLD.book_uid);
END;
