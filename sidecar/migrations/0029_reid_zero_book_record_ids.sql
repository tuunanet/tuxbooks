-- Sync-replayed restores could rebuild a book_records row with the
-- snapshot's book_id 0 (local_snapshot_json defaults it when the record was
-- absent at snapshot time), and restore_replace bound that id
-- unconditionally, inserting rowid 0. Row 0 breaks every id>0 invariant:
-- the IPC policy rejects it ("invalid bookIds") and later sync-replayed
-- restores collide on the UNIQUE primary key, wedging their Retry.
-- Re-id such rows to the next free id; no cross-table reference points at
-- book_records.id (state links by uid), so the rowid change is safe.

UPDATE book_records
SET id = (SELECT MAX(id) FROM book_records) + 1
WHERE id <= 0;
