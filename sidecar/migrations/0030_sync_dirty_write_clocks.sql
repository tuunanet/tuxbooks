-- Write-time operation clocks (ADR 0017 D3, ticket tuxbooks-0b2.2).
--
-- A sync_dirty row used to carry only the canonical snapshot; build_op minted
-- the op clock from `next_hlc` when the capture pass drained the queue. A
-- device offline for a month stamped month-old edits with reconnect-time
-- clocks, and those clocks won last-writer-wins against everything written
-- since. The clock now mints when the local write happens, inside the same
-- write transaction that produced the row.
--
-- The mint lives on sync_dirty itself instead of in every capture trigger:
-- the dirty writers span migrations 0015, 0018, 0019, and 0023 plus two Rust
-- statements (identity marks and the baseline pass), and any future writer
-- gets write-time clocks for free. A trigger body cannot use RETURNING, so
-- the mint is the same single-statement upsert `next_hlc` uses followed by a
-- read-back into the row. Both statements run inside the transaction of the
-- statement that fired them; SQLite serializes write transactions, so two
-- writes can never mint the same clock. The stamp touches only the new
-- columns, which keeps the AFTER UPDATE OF list from re-firing the trigger.

ALTER TABLE sync_dirty ADD COLUMN hlc_wall INTEGER;
ALTER TABLE sync_dirty ADD COLUMN hlc_counter INTEGER;

-- Legacy rows predate the columns and have no clock. changed_at is the write
-- time the old triggers recorded, so each row is dated from it, clamped to
-- the stored clock for a device whose wall clock stepped backward, and each
-- row takes the next counter slot in write order. The stored clock then
-- settles past the batch, so a future mint never collides with a legacy slot.
-- A database with no pending rows skips all of this (the EXISTS guard); a
-- fresh one merely initializes the clock at '0:0', which the first mint
-- moves past immediately.
WITH legacy AS (
    SELECT rowid AS rid, changed_at,
           MAX(
               CAST(unixepoch(changed_at, 'subsec') * 1000 AS INTEGER),
               COALESCE(CAST(substr((SELECT value FROM sync_meta WHERE key = 'hlc'), 1,
                           instr((SELECT value FROM sync_meta WHERE key = 'hlc'), ':') - 1)
                   AS INTEGER), 0)
           ) AS wall
    FROM sync_dirty
    WHERE hlc_wall IS NULL
),
ranked AS (
    SELECT rid, wall,
           COALESCE(CAST(substr((SELECT value FROM sync_meta WHERE key = 'hlc'),
                       instr((SELECT value FROM sync_meta WHERE key = 'hlc'), ':') + 1)
                   AS INTEGER), 0)
               + ROW_NUMBER() OVER (ORDER BY wall, changed_at, rid) AS slot
    FROM legacy
)
UPDATE sync_dirty
SET hlc_wall    = (SELECT wall FROM ranked WHERE rid = sync_dirty.rowid),
    hlc_counter = (SELECT slot FROM ranked WHERE rid = sync_dirty.rowid)
WHERE rowid IN (SELECT rid FROM ranked);

INSERT INTO sync_meta (key, value)
VALUES ('hlc', printf('%d:%d',
    COALESCE((SELECT MAX(hlc_wall) FROM sync_dirty), 0),
    COALESCE((SELECT MAX(hlc_counter) FROM sync_dirty), 0)))
ON CONFLICT(key) DO UPDATE SET value =
    printf('%d:%d',
        MAX(
            CAST(substr(sync_meta.value, 1, instr(sync_meta.value, ':') - 1) AS INTEGER),
            COALESCE((SELECT MAX(hlc_wall) FROM sync_dirty), 0)
        ),
        CAST(substr(sync_meta.value, instr(sync_meta.value, ':') + 1) AS INTEGER)
            + (SELECT COUNT(*) FROM sync_dirty WHERE hlc_wall IS NOT NULL)
    )
WHERE EXISTS (SELECT 1 FROM sync_dirty WHERE hlc_wall IS NOT NULL);

CREATE TRIGGER sync_dirty_clock_ai AFTER INSERT ON sync_dirty
-- Keep in sync with next_hlc/observe_hlc in sidecar/src/sync/clock.rs:
-- the four HLC mint sites change together.
BEGIN
    INSERT INTO sync_meta (key, value)
    VALUES ('hlc', printf('%d:0', CAST(unixepoch('subsec') * 1000 AS INTEGER)))
    ON CONFLICT(key) DO UPDATE SET value =
        CASE
            WHEN CAST(unixepoch('subsec') * 1000 AS INTEGER)
               > CAST(substr(sync_meta.value, 1, instr(sync_meta.value, ':') - 1) AS INTEGER)
            THEN printf('%d:0', CAST(unixepoch('subsec') * 1000 AS INTEGER))
            ELSE printf(
                '%d:%d',
                CAST(substr(sync_meta.value, 1, instr(sync_meta.value, ':') - 1) AS INTEGER),
                CAST(substr(sync_meta.value, instr(sync_meta.value, ':') + 1) AS INTEGER) + 1
            )
        END;
    UPDATE sync_dirty SET
        hlc_wall = CAST(substr((SELECT value FROM sync_meta WHERE key = 'hlc'), 1,
                        instr((SELECT value FROM sync_meta WHERE key = 'hlc'), ':') - 1) AS INTEGER),
        hlc_counter = CAST(substr((SELECT value FROM sync_meta WHERE key = 'hlc'),
                        instr((SELECT value FROM sync_meta WHERE key = 'hlc'), ':') + 1) AS INTEGER)
    WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER sync_dirty_clock_au AFTER UPDATE OF op, old_json, new_json, changed_at
ON sync_dirty
-- Keep in sync with next_hlc/observe_hlc in sidecar/src/sync/clock.rs:
-- the four HLC mint sites change together.
BEGIN
    INSERT INTO sync_meta (key, value)
    VALUES ('hlc', printf('%d:0', CAST(unixepoch('subsec') * 1000 AS INTEGER)))
    ON CONFLICT(key) DO UPDATE SET value =
        CASE
            WHEN CAST(unixepoch('subsec') * 1000 AS INTEGER)
               > CAST(substr(sync_meta.value, 1, instr(sync_meta.value, ':') - 1) AS INTEGER)
            THEN printf('%d:0', CAST(unixepoch('subsec') * 1000 AS INTEGER))
            ELSE printf(
                '%d:%d',
                CAST(substr(sync_meta.value, 1, instr(sync_meta.value, ':') - 1) AS INTEGER),
                CAST(substr(sync_meta.value, instr(sync_meta.value, ':') + 1) AS INTEGER) + 1
            )
        END;
    UPDATE sync_dirty SET
        hlc_wall = CAST(substr((SELECT value FROM sync_meta WHERE key = 'hlc'), 1,
                        instr((SELECT value FROM sync_meta WHERE key = 'hlc'), ':') - 1) AS INTEGER),
        hlc_counter = CAST(substr((SELECT value FROM sync_meta WHERE key = 'hlc'),
                        instr((SELECT value FROM sync_meta WHERE key = 'hlc'), ':') + 1) AS INTEGER)
    WHERE rowid = NEW.rowid;
END;
