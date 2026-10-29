-- Confirmed cross-edition links (ADR 0014 D9, ticket tuxbooks-ip6.8).
--
-- Two different editions of one work stay two durable books. This table only
-- records that the user confirmed they belong together; it never merges
-- identities, files, progress rows, or annotations.
--
-- The pair is stored in a deterministic order (`book_uid_a < book_uid_b`) so
-- one relation has exactly one row regardless of which book the user opened
-- first. Both columns cascade when a durable book is forgotten/deleted.
--
-- Links are local for now: there is no sync capture or projection here.
-- Forward-only: a rolled-back app fails closed on the newer schema version.

CREATE TABLE book_edition_links (
    book_uid_a TEXT NOT NULL REFERENCES book_records(uid) ON DELETE CASCADE,
    book_uid_b TEXT NOT NULL REFERENCES book_records(uid) ON DELETE CASCADE,
    linked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (book_uid_a, book_uid_b),
    CHECK (book_uid_a < book_uid_b)
);

-- Lookups from the other side of the relation; the primary key covers the
-- lower-sorted uuid.
CREATE INDEX idx_book_edition_links_b ON book_edition_links(book_uid_b);
