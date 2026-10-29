-- Durable collections, metadata, and last-opened (ADR 0014, ticket
-- tuxbooks-ip6.4).
--
-- T1/T2 moved reading progress, annotations, and the durable book record into
-- place. This migration finishes the split:
--
--   * collection membership, metadata overrides, and the normalized
--     author/subject lists are re-keyed by `book_uid`; no user-state table
--     cascades when a file row is deleted;
--   * effective metadata moves to `book_records`; `books` keeps the per-file
--     source values that the importer refreshes;
--   * `books.last_opened_at` disappears; the durable record owns it;
--   * FTS indexes the durable book (membership filters still decide whether a
--     hit is in the library);
--   * sync capture triggers read `book_uid` directly instead of resolving a
--     per-file binding.
--
-- Duplicate file rows that already share one identity union their collection
-- membership, keep the newest last-opened and metadata overrides, and record a
-- visible issue when the newest value is ambiguous.
--
-- Forward-only: a rolled-back app fails closed on the newer schema version.

-- ---------------------------------------------------------------------------
-- Drop the old capture plumbing before its tables change shape
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS books_fts_au;
DROP TRIGGER IF EXISTS books_fts_ad;
DROP TRIGGER IF EXISTS books_fts_ai;
DROP TABLE IF EXISTS books_fts;

DROP TRIGGER IF EXISTS book_records_ai;
DROP TRIGGER IF EXISTS book_records_au;

DROP TRIGGER IF EXISTS sync_books_opened_au;
DROP TRIGGER IF EXISTS sync_metadata_ai;
DROP TRIGGER IF EXISTS sync_metadata_au;
DROP TRIGGER IF EXISTS sync_metadata_ad;
DROP TRIGGER IF EXISTS sync_book_authors_ai;
DROP TRIGGER IF EXISTS sync_book_authors_au;
DROP TRIGGER IF EXISTS sync_book_authors_ad;
DROP TRIGGER IF EXISTS sync_book_subjects_ai;
DROP TRIGGER IF EXISTS sync_book_subjects_au;
DROP TRIGGER IF EXISTS sync_book_subjects_ad;
DROP TRIGGER IF EXISTS sync_book_collections_ai;
DROP TRIGGER IF EXISTS sync_book_collections_ad;
DROP VIEW IF EXISTS sync_metadata_snapshot;

-- ---------------------------------------------------------------------------
-- The file row that supplies a book's source metadata
-- ---------------------------------------------------------------------------
--
-- A book can have several file rows. The most recently refreshed file is the
-- source of truth for the effective view; when a duplicate is re-imported it
-- becomes the primary file, so its fresh source values win without touching
-- the user's overrides. Ties fall back to the highest file id, which is what
-- the 0017 snapshot used.

CREATE TEMP TABLE _primary_file AS
SELECT book_uid, file_id AS file_id
FROM (
    SELECT
        b.book_uid,
        b.id AS file_id,
        ROW_NUMBER() OVER (
            PARTITION BY b.book_uid ORDER BY b.modified_at DESC, b.id DESC
        ) AS rn
    FROM books b
    WHERE b.book_uid IS NOT NULL
)
WHERE rn = 1;

-- The override row of the newest file copy that has one. `modified_at` is the
-- only ordering signal the pre-split schema kept for curation.
CREATE TEMP TABLE _chosen_override AS
SELECT b.book_uid, o.*
FROM book_metadata_overrides o
JOIN books b ON b.id = o.book_id
WHERE b.book_uid IS NOT NULL
  AND b.id = (
      SELECT b2.id
      FROM books b2
      JOIN book_metadata_overrides o2 ON o2.book_id = b2.id
      WHERE b2.book_uid = b.book_uid
      ORDER BY b2.modified_at DESC, b2.id DESC
      LIMIT 1
  );

-- ---------------------------------------------------------------------------
-- Union collection membership by durable book
-- ---------------------------------------------------------------------------

CREATE TABLE book_collections_new (
    book_uid      TEXT    NOT NULL REFERENCES book_records(uid) ON DELETE CASCADE,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    added_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (book_uid, collection_id)
);

INSERT OR IGNORE INTO book_collections_new (book_uid, collection_id, added_at)
SELECT b.book_uid, bc.collection_id, MIN(bc.added_at)
FROM book_collections bc
JOIN books b ON b.id = bc.book_id
WHERE b.book_uid IS NOT NULL
GROUP BY b.book_uid, bc.collection_id;

INSERT INTO migration_issues (issue_key, kind, detail, book_uid)
SELECT
    'duplicate-collections:' || b.book_uid,
    'duplicate_state_merged',
    'These copies of one book were in the same collection; the membership was unioned.',
    b.book_uid
FROM book_collections bc
JOIN books b ON b.id = bc.book_id
WHERE b.book_uid IS NOT NULL
GROUP BY b.book_uid, bc.collection_id
HAVING COUNT(*) > 1;

DROP TABLE book_collections;
ALTER TABLE book_collections_new RENAME TO book_collections;
CREATE INDEX idx_book_collections_collection ON book_collections(collection_id);

-- ---------------------------------------------------------------------------
-- Keep the newest metadata overrides by durable book
-- ---------------------------------------------------------------------------

CREATE TABLE book_metadata_overrides_new (
    book_uid            TEXT PRIMARY KEY REFERENCES book_records(uid) ON DELETE CASCADE,
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

INSERT INTO book_metadata_overrides_new (
    book_uid, title, subtitle, publisher, language, isbn, description,
    publication_date, series, series_index, cover_path,
    authors_customized, subjects_customized
)
SELECT
    co.book_uid, co.title, co.subtitle, co.publisher, co.language, co.isbn,
    co.description, co.publication_date, co.series, co.series_index,
    co.cover_path, co.authors_customized, co.subjects_customized
FROM _chosen_override co;

INSERT INTO migration_issues (issue_key, kind, detail, book_uid)
SELECT
    'duplicate-metadata:' || b.book_uid,
    'duplicate_state_merged',
    'This book had metadata overrides on more than one copy. The newest copy won'
        || CASE
            WHEN COUNT(DISTINCT b.modified_at) = 1
            THEN '; the timestamps tied, so which one is newest is ambiguous.'
            ELSE '.'
        END,
    b.book_uid
FROM book_metadata_overrides o
JOIN books b ON b.id = o.book_id
WHERE b.book_uid IS NOT NULL
GROUP BY b.book_uid
HAVING COUNT(*) > 1;

DROP TABLE book_metadata_overrides;
ALTER TABLE book_metadata_overrides_new RENAME TO book_metadata_overrides;

-- ---------------------------------------------------------------------------
-- Normalized author and subject lists follow the durable book
-- ---------------------------------------------------------------------------

CREATE TABLE book_authors_new (
    book_uid  TEXT    NOT NULL REFERENCES book_records(uid) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (book_uid, author_id)
);

CREATE TABLE book_subjects_new (
    book_uid   TEXT    NOT NULL REFERENCES book_records(uid) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    PRIMARY KEY (book_uid, subject_id)
);

-- A customized list is user state: keep the newest copy's list.
INSERT OR IGNORE INTO book_authors_new (book_uid, author_id, position)
SELECT co.book_uid, ba.author_id, ba.position
FROM _chosen_override co
JOIN books b ON b.id = co.book_id
JOIN book_authors ba ON ba.book_id = b.id
WHERE co.authors_customized = 1;

INSERT OR IGNORE INTO book_subjects_new (book_uid, subject_id)
SELECT co.book_uid, bs.subject_id
FROM _chosen_override co
JOIN books b ON b.id = co.book_id
JOIN book_subjects bs ON bs.book_id = b.id
WHERE co.subjects_customized = 1;

-- Files name authors/subjects that the normalized tables may not have seen
-- yet (only the primary file's list matters for the effective view).
INSERT OR IGNORE INTO authors (name)
SELECT DISTINCT j.value
FROM _primary_file p
JOIN book_source_metadata s ON s.book_id = p.file_id,
     json_each(COALESCE(s.authors, '[]')) j
WHERE j.value IS NOT NULL AND trim(j.value) != '';

INSERT OR IGNORE INTO subjects (name)
SELECT DISTINCT j.value
FROM _primary_file p
JOIN book_source_metadata s ON s.book_id = p.file_id,
     json_each(COALESCE(s.subjects, '[]')) j
WHERE j.value IS NOT NULL AND trim(j.value) != '';

-- A list that is not customized still follows the file. Materialize the
-- primary file's list so the effective columns and sync snapshot agree.
INSERT OR IGNORE INTO book_authors_new (book_uid, author_id, position)
SELECT p.book_uid, a.id, CAST(j.key AS INTEGER)
FROM _primary_file p
JOIN book_source_metadata s ON s.book_id = p.file_id,
     json_each(COALESCE(s.authors, '[]')) j
JOIN authors a ON a.name = j.value
WHERE COALESCE(
    (SELECT co.authors_customized FROM _chosen_override co WHERE co.book_uid = p.book_uid),
    0
) = 0;

INSERT OR IGNORE INTO book_subjects_new (book_uid, subject_id)
SELECT p.book_uid, s2.id
FROM _primary_file p
JOIN book_source_metadata s ON s.book_id = p.file_id,
     json_each(COALESCE(s.subjects, '[]')) j
JOIN subjects s2 ON s2.name = j.value
WHERE COALESCE(
    (SELECT co.subjects_customized FROM _chosen_override co WHERE co.book_uid = p.book_uid),
    0
) = 0;

DROP TABLE book_authors;
ALTER TABLE book_authors_new RENAME TO book_authors;
DROP TABLE book_subjects;
ALTER TABLE book_subjects_new RENAME TO book_subjects;

-- ---------------------------------------------------------------------------
-- Effective metadata moves to the durable record
-- ---------------------------------------------------------------------------

ALTER TABLE book_records ADD COLUMN series_id INTEGER REFERENCES series(id) ON DELETE SET NULL;

CREATE TEMP TABLE _effective_metadata AS
SELECT
    p.book_uid,
    COALESCE(NULLIF(co.title, ''), NULLIF(s.title, ''), pb.title, 'Unknown') AS title,
    CASE
        WHEN co.subtitle IS NOT NULL THEN NULLIF(co.subtitle, '')
        ELSE NULLIF(s.subtitle, '')
    END AS subtitle,
    CASE
        WHEN co.publisher IS NOT NULL THEN NULLIF(co.publisher, '')
        ELSE NULLIF(s.publisher, '')
    END AS publisher,
    CASE
        WHEN co.language IS NOT NULL THEN NULLIF(co.language, '')
        ELSE NULLIF(s.language, '')
    END AS language,
    CASE
        WHEN co.isbn IS NOT NULL THEN NULLIF(co.isbn, '')
        ELSE NULLIF(s.isbn, '')
    END AS isbn,
    CASE
        WHEN co.description IS NOT NULL THEN NULLIF(co.description, '')
        ELSE NULLIF(s.description, '')
    END AS description,
    CASE
        WHEN co.publication_date IS NOT NULL THEN NULLIF(co.publication_date, '')
        ELSE NULLIF(s.publication_date, '')
    END AS publication_date,
    CASE
        WHEN co.series IS NOT NULL THEN NULLIF(co.series, '')
        ELSE NULLIF(s.series, '')
    END AS series,
    CASE
        WHEN co.series IS NOT NULL
        THEN CASE WHEN co.series = '' THEN NULL ELSE co.series_index END
        ELSE s.series_index
    END AS series_index,
    COALESCE(NULLIF(co.cover_path, ''), NULLIF(s.cover_path, '')) AS cover_path,
    (
        SELECT group_concat(name, ', ')
        FROM (
            SELECT a.name AS name
            FROM book_authors ba
            JOIN authors a ON a.id = ba.author_id
            WHERE ba.book_uid = p.book_uid
            ORDER BY ba.position, a.name
        )
    ) AS author
FROM _primary_file p
LEFT JOIN _chosen_override co ON co.book_uid = p.book_uid
LEFT JOIN book_source_metadata s ON s.book_id = p.file_id
LEFT JOIN books pb ON pb.id = p.file_id;

INSERT OR IGNORE INTO series (name)
SELECT DISTINCT series
FROM _effective_metadata
WHERE series IS NOT NULL AND trim(series) != '';

UPDATE book_records
SET title = (SELECT e.title FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    subtitle = (SELECT e.subtitle FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    author = (SELECT e.author FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    publisher = (SELECT e.publisher FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    language = (SELECT e.language FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    isbn = (SELECT e.isbn FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    description = (SELECT e.description FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    publication_date = (SELECT e.publication_date FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    series = (SELECT e.series FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    series_index = (SELECT e.series_index FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    series_id = (
        SELECT se.id FROM series se
        WHERE se.name = (SELECT e.series FROM _effective_metadata e WHERE e.book_uid = book_records.uid)
    ),
    cover_path = (SELECT e.cover_path FROM _effective_metadata e WHERE e.book_uid = book_records.uid),
    metadata_state = 'available'
WHERE uid IN (SELECT book_uid FROM _effective_metadata);

DROP TABLE _effective_metadata;
DROP TABLE _chosen_override;
DROP TABLE _primary_file;

-- Last-opened belongs to the durable book. The 0017 snapshot already took the
-- latest value for rows that existed then; this also covers duplicate file
-- rows created after the split (and keeps a recovered mirror timestamp when
-- no file has one).
INSERT INTO migration_issues (issue_key, kind, detail, book_uid)
SELECT
    'duplicate-opened:' || b.book_uid,
    'duplicate_state_merged',
    'This book had more than one last-opened timestamp across its copies. '
        || 'The newest one was kept.',
    b.book_uid
FROM books b
WHERE b.book_uid IS NOT NULL
  AND b.last_opened_at IS NOT NULL
GROUP BY b.book_uid
HAVING COUNT(DISTINCT b.last_opened_at) > 1;

UPDATE book_records
SET last_opened_at = COALESCE(
    (SELECT MAX(b.last_opened_at) FROM books b WHERE b.book_uid = book_records.uid),
    last_opened_at
)
WHERE uid IN (SELECT book_uid FROM books WHERE book_uid IS NOT NULL);

ALTER TABLE books DROP COLUMN last_opened_at;

-- ---------------------------------------------------------------------------
-- Keep the durable snapshot in step with a new file row
-- ---------------------------------------------------------------------------

CREATE TRIGGER book_records_ai AFTER INSERT ON books
WHEN NEW.book_uid IS NOT NULL
BEGIN
    INSERT INTO book_records (
        uid, title, subtitle, author, publisher, language, isbn, description,
        publication_date, series, series_index, series_id, cover_path,
        metadata_state
    )
    VALUES (
        NEW.book_uid, NEW.title, NEW.subtitle, NEW.author, NEW.publisher,
        NEW.language, NEW.isbn, NEW.description, NEW.publication_date,
        (SELECT name FROM series WHERE id = NEW.series_id), NEW.series_index,
        NEW.series_id, NEW.cover_path, 'available'
    )
    ON CONFLICT(uid) DO NOTHING;
END;

-- ---------------------------------------------------------------------------
-- Search indexes the durable book, filtered to current memberships
-- ---------------------------------------------------------------------------
--
-- A regular FTS5 table (not external-content) so the indexed path can come
-- from the book's active file row without making `books` the metadata owner.
-- Reading-history books may have an index row; every query joins the active
-- file, so they never appear in library search.

CREATE VIRTUAL TABLE books_fts USING fts5(
    title,
    subtitle,
    author,
    publisher,
    isbn,
    description,
    path,
    tokenize = 'unicode61'
);

INSERT INTO books_fts (rowid, title, subtitle, author, publisher, isbn, description, path)
SELECT
    br.id, br.title, br.subtitle, br.author, br.publisher, br.isbn,
    br.description,
    (SELECT b.path FROM books b WHERE b.book_uid = br.uid
     ORDER BY b.available DESC, b.id LIMIT 1)
FROM book_records br;

CREATE TRIGGER books_fts_br_ai AFTER INSERT ON book_records
BEGIN
    INSERT INTO books_fts (rowid, title, subtitle, author, publisher, isbn, description, path)
    SELECT
        NEW.id, NEW.title, NEW.subtitle, NEW.author, NEW.publisher, NEW.isbn,
        NEW.description,
        (SELECT b.path FROM books b WHERE b.book_uid = NEW.uid
         ORDER BY b.available DESC, b.id LIMIT 1);
END;

CREATE TRIGGER books_fts_br_au
AFTER UPDATE OF title, subtitle, author, publisher, isbn, description ON book_records
BEGIN
    DELETE FROM books_fts WHERE rowid = OLD.id;
    INSERT INTO books_fts (rowid, title, subtitle, author, publisher, isbn, description, path)
    SELECT
        NEW.id, NEW.title, NEW.subtitle, NEW.author, NEW.publisher, NEW.isbn,
        NEW.description,
        (SELECT b.path FROM books b WHERE b.book_uid = NEW.uid
         ORDER BY b.available DESC, b.id LIMIT 1);
END;

CREATE TRIGGER books_fts_br_ad AFTER DELETE ON book_records
BEGIN
    DELETE FROM books_fts WHERE rowid = OLD.id;
END;

CREATE TRIGGER books_fts_books_au
AFTER UPDATE OF path, available, book_uid ON books
WHEN NEW.book_uid IS NOT NULL
BEGIN
    DELETE FROM books_fts
    WHERE rowid = (SELECT id FROM book_records WHERE uid = NEW.book_uid);
    INSERT INTO books_fts (rowid, title, subtitle, author, publisher, isbn, description, path)
    SELECT
        br.id, br.title, br.subtitle, br.author, br.publisher, br.isbn,
        br.description,
        (SELECT b.path FROM books b WHERE b.book_uid = br.uid
         ORDER BY b.available DESC, b.id LIMIT 1)
    FROM book_records br
    WHERE br.uid = NEW.book_uid
      AND EXISTS (SELECT 1 FROM books b WHERE b.book_uid = br.uid);
END;

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
    WHERE br.uid = OLD.book_uid
      AND EXISTS (SELECT 1 FROM books b WHERE b.book_uid = br.uid);
END;

-- ---------------------------------------------------------------------------
-- Sync capture follows the durable key
-- ---------------------------------------------------------------------------

CREATE VIEW sync_metadata_snapshot AS
SELECT
    o.book_uid AS book_uid,
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
                    WHERE ba.book_uid = o.book_uid
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
                    WHERE bs.book_uid = o.book_uid
                    ORDER BY s.name
                ))
            ELSE NULL END
    ) AS snapshot_json
FROM book_metadata_overrides o;

CREATE TRIGGER sync_metadata_ai AFTER INSERT ON book_metadata_overrides
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = NEW.book_uid)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', NEW.book_uid, 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_uid = NEW.book_uid
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_metadata_au AFTER UPDATE ON book_metadata_overrides
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = NEW.book_uid)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', NEW.book_uid, 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_uid = NEW.book_uid
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

-- Reset deletes the override row; the canonical state becomes all NULL.
CREATE TRIGGER sync_metadata_ad AFTER DELETE ON book_metadata_overrides
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = OLD.book_uid)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'metadata',
        OLD.book_uid,
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
WHEN COALESCE((SELECT authors_customized FROM book_metadata_overrides WHERE book_uid = NEW.book_uid), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', NEW.book_uid, 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_uid = NEW.book_uid
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_authors_au AFTER UPDATE ON book_authors
WHEN COALESCE((SELECT authors_customized FROM book_metadata_overrides WHERE book_uid = NEW.book_uid), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', NEW.book_uid, 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_uid = NEW.book_uid
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_authors_ad AFTER DELETE ON book_authors
WHEN COALESCE((SELECT authors_customized FROM book_metadata_overrides WHERE book_uid = OLD.book_uid), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', OLD.book_uid, 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_uid = OLD.book_uid
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_subjects_ai AFTER INSERT ON book_subjects
WHEN COALESCE((SELECT subjects_customized FROM book_metadata_overrides WHERE book_uid = NEW.book_uid), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', NEW.book_uid, 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_uid = NEW.book_uid
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_subjects_au AFTER UPDATE ON book_subjects
WHEN COALESCE((SELECT subjects_customized FROM book_metadata_overrides WHERE book_uid = NEW.book_uid), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', NEW.book_uid, 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_uid = NEW.book_uid
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_subjects_ad AFTER DELETE ON book_subjects
WHEN COALESCE((SELECT subjects_customized FROM book_metadata_overrides WHERE book_uid = OLD.book_uid), 0) = 1
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    SELECT 'metadata', OLD.book_uid, 'upsert', NULL, snapshot_json
    FROM sync_metadata_snapshot WHERE book_uid = OLD.book_uid
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_opened_au AFTER UPDATE OF last_opened_at ON book_records
WHEN OLD.last_opened_at IS NOT NEW.last_opened_at
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'opened',
        NEW.uid,
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

-- Membership rows disappear when a collection is deleted. A file-row delete no
-- longer touches them; this cascade is a local change, not a shared delete.
CREATE TRIGGER sync_book_collections_ai AFTER INSERT ON book_collections
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = NEW.book_uid)
 AND EXISTS (SELECT 1 FROM collections WHERE id = NEW.collection_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'membership',
        NEW.book_uid || ':' || CAST(NEW.collection_id AS TEXT),
        'upsert',
        NULL,
        json_object(
            'book_uid', NEW.book_uid,
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
WHEN EXISTS (SELECT 1 FROM book_records WHERE uid = OLD.book_uid)
 AND EXISTS (SELECT 1 FROM collections WHERE id = OLD.collection_id)
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'membership',
        OLD.book_uid || ':' || CAST(OLD.collection_id AS TEXT),
        'delete',
        json_object(
            'book_uid', OLD.book_uid,
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
