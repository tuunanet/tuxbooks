-- Third-party provider links (ADR 0014 D11, ticket tuxbooks-ip6.3).
--
-- A provider link belongs to the durable book, never to a file row, so it
-- survives unwatch, Remove, and re-import. The provider's own reading status
-- is cached on the link; TuxBooks keeps using `reading_progress` as its
-- reading status model (see docs/PROVIDERS.md for the mapping).
--
-- `book_provider_pending_progress` is the outgoing page-turn queue. It is
-- keyed by durable book and holds at most one pending progress value per
-- link, because a later page turn replaces an unsent earlier one. Remote
-- updates never write here.
--
-- Forward-only: a rolled-back app fails closed on the newer schema version.

CREATE TABLE book_provider_links (
    book_uid          TEXT NOT NULL REFERENCES book_records(uid) ON DELETE CASCADE,
    provider          TEXT NOT NULL CHECK (trim(provider) != ''),
    remote_id         TEXT NOT NULL CHECK (trim(remote_id) != ''),
    status            TEXT CHECK (
        status IS NULL OR status IN (
            'want_to_read', 'reading', 'paused', 'finished', 'dropped'
        )
    ),
    status_updated_at TEXT,
    linked_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (book_uid, provider),
    UNIQUE (provider, remote_id)
);

CREATE TABLE book_provider_pending_progress (
    book_uid         TEXT NOT NULL,
    provider         TEXT NOT NULL,
    progress_percent REAL NOT NULL CHECK (
        progress_percent BETWEEN 0 AND 100
    ),
    queued_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (book_uid, provider),
    FOREIGN KEY (book_uid, provider)
        REFERENCES book_provider_links(book_uid, provider) ON DELETE CASCADE
);
