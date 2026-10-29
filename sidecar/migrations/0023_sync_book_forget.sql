-- Shared Forget and durable-state capture (ADR 0014 D3/D5, ticket
-- tuxbooks-ip6.9).
--
-- Forgotten books take the same shared-delete path as an annotation, but a
-- whole book is not a per-entity trash row. `sync_book_trash` is the mirror's
-- record of a book-level tombstone: the portable snapshot, the fresh identity
-- when the file stayed in the library, and the 30-day restore clock. The local
-- `book_trash` table remains the Reading-history surface and gains only the
-- resolution the user chose (restore, or discard through Keep/Merge).
--
-- `sync_source_trash` below is intentionally not a thing: `sync_trash` keeps
-- its existing per-entity shape.
--
-- Capturing a Forget records the old identity as dead. Receivers rebind their
-- file rows to the fresh identity, remove the old aliases, and keep the
-- snapshot in their own trash, so the old uuid cannot come back through an
-- alias or an in-flight operation.
--
-- Forward-only: a rolled-back app fails closed on the newer schema version.

ALTER TABLE book_trash ADD COLUMN resolution TEXT
    CHECK (resolution IS NULL OR resolution IN ('restore', 'discard'));

-- One open entry per identity. A restored entry keeps its row for history and
-- a later Forget of the same identity may create a new one. Pre-existing
-- duplicates (there should be none) keep the newest and are marked resolved.
UPDATE book_trash SET restored_at = deleted_at
WHERE restored_at IS NULL
  AND id NOT IN (
      SELECT MAX(id) FROM book_trash WHERE restored_at IS NULL GROUP BY book_uid
  );
CREATE UNIQUE INDEX book_trash_open_uid
    ON book_trash(book_uid) WHERE restored_at IS NULL;

CREATE TABLE sync_book_trash (
    book_uid             TEXT PRIMARY KEY,
    replacement_book_uid TEXT,
    -- Portable snapshot (collection memberships carry collection uids).
    -- NULL when the sender could not serialize it; the receiver records a
    -- visible issue instead of silently dropping the bookmark.
    snapshot_json        TEXT,
    deleted_wall         INTEGER NOT NULL,
    deleted_count        INTEGER NOT NULL,
    deleted_dev          TEXT NOT NULL,
    deleted_at           TEXT NOT NULL,
    expires_at           TEXT NOT NULL,
    restored_at          TEXT,
    -- 1 when the user chose Keep or Merge: the old identity stays forgotten
    -- and only the local trash entry is closed.
    discarded            INTEGER NOT NULL DEFAULT 0,
    restored_wall        INTEGER NOT NULL DEFAULT 0,
    restored_count       INTEGER NOT NULL DEFAULT 0,
    restored_dev         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sync_book_trash_open ON sync_book_trash(restored_at, expires_at);
CREATE INDEX sync_book_trash_replacement ON sync_book_trash(replacement_book_uid);

-- ---------------------------------------------------------------------------
-- Local Forget and restore markers
-- ---------------------------------------------------------------------------
--
-- The trigger runs whether sync is on or off. The local-only path never reads
-- these rows; when a folder is connected later they drain through the normal
-- capture pass. A projection that writes a remote trash row fires the same
-- trigger, but capture sees the mirror already holds the tombstone and drops
-- the echo.

CREATE TRIGGER sync_book_trash_ai AFTER INSERT ON book_trash
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'book',
        NEW.book_uid,
        'delete',
        json_object(
            'snapshot_json', NEW.snapshot_json,
            'replacement_book_uid', NEW.replacement_book_uid
        ),
        NULL
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'delete',
        old_json = excluded.old_json,
        new_json = NULL,
        changed_at = excluded.changed_at;
END;

CREATE TRIGGER sync_book_trash_au AFTER UPDATE OF restored_at ON book_trash
WHEN OLD.restored_at IS NULL AND NEW.restored_at IS NOT NULL
BEGIN
    INSERT INTO sync_dirty (kind, entity_key, op, old_json, new_json)
    VALUES (
        'book',
        NEW.book_uid,
        'upsert',
        NULL,
        json_object(
            'action', COALESCE(NEW.resolution, 'restore'),
            'snapshot_json', NEW.snapshot_json,
            'replacement_book_uid', NEW.replacement_book_uid
        )
    )
    ON CONFLICT(kind, entity_key) DO UPDATE SET
        op = 'upsert',
        old_json = NULL,
        new_json = excluded.new_json,
        changed_at = excluded.changed_at;
END;

-- ---------------------------------------------------------------------------
-- Annotation capture reads the durable key directly
-- ---------------------------------------------------------------------------
--
-- 0018 produced the public numeric id in the marker and made capture resolve
-- it back to a book. The trigger now carries book_uid beside the public id, so
-- capture never looks up a row or a sync binding.

DROP TRIGGER IF EXISTS sync_annotations_ai;
DROP TRIGGER IF EXISTS sync_annotations_au;
DROP TRIGGER IF EXISTS sync_annotations_ad;

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
            'book_uid', NEW.book_uid,
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
            'book_uid', NEW.book_uid,
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
            'book_uid', OLD.book_uid,
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
