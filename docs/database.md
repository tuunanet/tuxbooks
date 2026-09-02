# Database

SQLite (bundled, via SQLx) at a single file path. Migrations live in
`src-tauri/migrations/` and are embedded at compile time with
`sqlx::migrate!`; they run automatically in `db::connection::init_pool`,
so a clean database always converges to the current schema. Add numbered
`.sql` files; never create schema procedurally at runtime.

Location: OS app-data dir (`tuxbooks.db`) unless `TEST_DATABASE_PATH` is
set. Timestamps are RFC 3339 TEXT (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
and `foreign_keys` is forced ON for every connection.

## Tables

### books

| column         | type                           | notes                      |
| -------------- | ------------------------------ | -------------------------- |
| id             | INTEGER PK AUTOINCREMENT       |                            |
| path           | TEXT NOT NULL UNIQUE           | absolute file path         |
| title          | TEXT NOT NULL, CHECK non-blank |                            |
| subtitle       | TEXT                           |                            |
| author         | TEXT                           |                            |
| publisher      | TEXT                           |                            |
| language       | TEXT                           |                            |
| isbn           | TEXT                           |                            |
| description    | TEXT                           |                            |
| cover_path     | TEXT                           | extracted cover image file |
| added_at       | TEXT NOT NULL, DB default      | set by INSERT              |
| modified_at    | TEXT NOT NULL, DB default      | bumped on UPDATE           |
| last_opened_at | TEXT NULL                      | set when reading starts    |

### collections

`id`, `name` (UNIQUE), `created_at`.

### book_collections

Join table, PK `(book_id, collection_id)`, both FK with
`ON DELETE CASCADE`.

### reading_progress

PK `book_id` (FK, cascade) — one progress row per book.
`chapter_href`, `character_offset`, `progress_percent`
(REAL, CHECK 0..=100 or NULL), `updated_at`.

## Full-text search

`books_fts` is an FTS5 **external-content** table over
`books(title, subtitle, author, description)` kept in sync by three
triggers (`books_fts_ai/ad/au`). Search code joins `books_fts.rowid =
books.id` and uses `snippet()`; the index never needs a backfill. If you
change `books` columns covered by the index, update those triggers — the
test `updating_book_keeps_fts_index_in_sync` must keep passing.

## Conventions

- All SQL lives in `repository/`; commands and services never embed SQL.
- Queries use runtime `sqlx::query`/`query_as` (not `query!` macros), so
  builds do not need `DATABASE_URL` or `sqlx prepare`.
- Imports upsert by `path`; a re-scan updates metadata instead of
  duplicating rows.
- Tests always create the pool in a `tempfile` temp dir.
