-- Reading-progress engine migration (docs/electron-migration.md, phase 3):
-- the stored row gains engine-locator columns so the foliate-era locator
-- (cfi + chapter_href) can be converted to a Readium locator without
-- destroying the original data.
--
-- The existing columns stay untouched:
--   cfi + chapter_href  — the foliate-era locator, kept as provenance.
--   page_number etc.    — the PDF locator (unchanged).
-- The new columns carry the engine locator for the active engine:
--   locator        — serialized Readium Locator JSON (EPUB).
--   progression    — the locator's totalProgression (0..1) for coarse use.
--   locations      — serialized Readium `locations` object JSON.
--   engine         — which engine wrote the locator ("readium"); NULL for
--                    rows the foliate app wrote (its locator lives in cfi).
--   schema_version — the locator schema version of the conversion.
-- Per-book completion marker: a non-NULL `engine` means the row has been
-- converted; the adapter never re-converts such rows (idempotency).
ALTER TABLE reading_progress ADD COLUMN locator TEXT;
ALTER TABLE reading_progress ADD COLUMN progression REAL;
ALTER TABLE reading_progress ADD COLUMN locations TEXT;
ALTER TABLE reading_progress ADD COLUMN engine TEXT;
ALTER TABLE reading_progress ADD COLUMN schema_version INTEGER;
