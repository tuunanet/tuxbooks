-- Per-field authority choice (issue #58, phase 4). Absence = default: use the
-- library override when one exists, otherwise the file value.
--
-- `field` names are the storage names of the merge layers (see migration
-- 0008): scalar columns, the `series` unit (name + index travel together),
-- and the normalized author/subject lists. `cover` is excluded — the cover
-- override is always authoritative until restored.
CREATE TABLE book_metadata_field_sources (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    field   TEXT NOT NULL CHECK (field IN (
        'title','subtitle','authors','publisher','language','isbn',
        'publication_date','series','subjects','description'
    )),
    source  TEXT NOT NULL CHECK (source IN ('library','file')),
    PRIMARY KEY (book_id, field)
);
