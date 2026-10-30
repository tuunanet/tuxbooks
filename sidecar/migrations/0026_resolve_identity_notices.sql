-- Identity merges are automatic and are no longer shown in Settings.
--
-- Earlier versions recorded every duplicate-byte collapse and duplicate-state
-- union as a migration issue and listed those rows in the Application Data
-- tab. That list grew without limit and asked users to interpret internal
-- uuids they could not act on. Merges now keep their audit trail in
-- sync_book_merges / sync_entity_merges, and duplicate copies are reported as
-- actionable sync issues instead. Resolve the informational rows an older
-- version left open; hash failures stay open because they still need a
-- relink.

UPDATE migration_issues
SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE resolved_at IS NULL
  AND kind IN ('identity_merged', 'duplicate_state_merged', 'duplicate_identity');
