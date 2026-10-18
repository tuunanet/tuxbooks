-- The per-field authority choice (migration 0010) belonged to the two-tab
-- metadata editor: its "Library metadata" tab let users pin individual
-- fields to the file value or the library value, and the merge rules read
-- the pins on every save and recompute.
--
-- That tab is gone — one metadata form, one Save that writes storeable
-- fields into the file — so nothing writes new pins and no merge rule reads
-- them. Drop the table; the overrides themselves (migration 0008) are
-- untouched and stay authoritative where they exist.
DROP TABLE book_metadata_field_sources;
