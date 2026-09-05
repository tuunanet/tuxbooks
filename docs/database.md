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

| column         | type                           | notes                       |
| -------------- | ------------------------------ | --------------------------- |
| id             | INTEGER PK AUTOINCREMENT       |                             |
| path           | TEXT NOT NULL UNIQUE           | absolute file path          |
| title          | TEXT NOT NULL, CHECK non-blank |                             |
| subtitle       | TEXT                           |                             |
| author         | TEXT                           |                             |
| publisher      | TEXT                           |                             |
| language       | TEXT                           |                             |
| isbn           | TEXT                           |                             |
| description    | TEXT                           |                             |
| cover_path     | TEXT                           | extracted cover image file  |
| added_at       | TEXT NOT NULL, DB default      | set by INSERT               |
| modified_at    | TEXT NOT NULL, DB default      | bumped on UPDATE            |
| last_opened_at | TEXT NULL                      | set when reading starts     |
| available      | INTEGER NOT NULL DEFAULT 1     | 0 once the file disappears  |
| file_size      | INTEGER NOT NULL DEFAULT 0     | bytes at last import        |
| file_mtime     | INTEGER NOT NULL DEFAULT 0     | unix seconds at last import |

`available`/`file_size`/`file_mtime` back the filesystem watcher (milestone
3): a disappeared file marks `available = 0` but never deletes the row
(metadata, collections, and reading progress are preserved for
reconnection), and the size/mtime snapshot lets the watcher distinguish
real modifications from duplicate events without re-parsing documents.

### library_locations

`id`, `path` (UNIQUE), `added_at`. The filesystem roots registered by
`scan_library` (or the test seeding); only these are watched and
reconciled. Books outside watched locations are never touched by
reconciliation — a fresh database that predates milestone 3 stays
unwatched until the next folder import.

### collections

`id`, `name` (UNIQUE), `created_at`.

### book_collections

Join table, PK `(book_id, collection_id)`, both FK with
`ON DELETE CASCADE`.

### reading_progress

PK `book_id` (FK, cascade) — one progress row per book.
`chapter_href`, `character_offset`, `progress_percent`
(REAL, CHECK 0..=100 or NULL), `updated_at`.

### annotations

One row per persistent reading annotation (milestone 6): bookmarks,
highlights, and the note attached to either (1:1 through the nullable
`note` column — there is no separate notes table).

| column        | type                                           | notes                                                         |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| id            | INTEGER PK AUTOINCREMENT                       |                                                               |
| book_id       | INTEGER NOT NULL, FK `books` ON DELETE CASCADE |                                                               |
| kind          | TEXT NOT NULL, CHECK `bookmark`\|`highlight`   |                                                               |
| cfi           | TEXT                                           | canonical EPUB CFI (bookmarks and highlights)                 |
| chapter_href  | TEXT                                           | spine href of the EPUB section (display grouping)             |
| page_number   | INTEGER, CHECK >= 1                            | 1-based PDF page                                              |
| page_fraction | REAL, CHECK 0..=1                              | optional page-local anchor (PDF bookmarks)                    |
| text          | TEXT                                           | selected text (highlights; mandatory for EPUB, optional PDF)  |
| color         | TEXT                                           | highlight palette key (`yellow`, `green`, …)                  |
| geometry      | TEXT                                           | JSON array of rects normalized to page space (PDF highlights) |
| note          | TEXT                                           | the attached note (empty string = no note text)               |
| created_at    | TEXT NOT NULL, DB default                      |                                                               |
| modified_at   | TEXT NOT NULL, DB default                      | bumped on UPDATE                                              |

Locator invariant: every row names one stable document position — a CFI or
a page number — never UI pixels. PDF highlight `geometry` is stored
normalized to page space (`0..1` per axis, validated by the service), so
highlights redraw correctly at any zoom or window size. Index on
`(book_id, kind)`; deleting a book cascades.

## Full-text search

`books_fts` is an FTS5 **external-content** table over
`books(title, subtitle, author, publisher, isbn, description, path)` kept
in sync by three triggers (`books_fts_ai/ad/au`). Search code joins
`books_fts.rowid = books.id` and uses `snippet(…, -1, …)` (automatic
column: the snippet comes from whichever column matched best); the index
never needs a backfill. Migration `0006` widened the index from the
original four columns (external-content tables cannot be altered, so the
table and triggers are recreated and `'rebuild'` re-reads every row); the
path column doubles as the file-name field — the default tokenizer splits
on `/` and `.`, so bare file-name tokens match. If you change `books`
columns covered by the index, update those triggers — the test
`updating_book_keeps_fts_index_in_sync` must keep passing.

User queries never reach FTS5 raw: `services/search.rs`
(`build_fts_query`) strips quotes and turns whitespace-separated tokens
into quoted prefix phrases ANDed together (`wind river` →
`"wind"* "river"*`), so input cannot inject MATCH syntax.

## Conventions

- All SQL lives in `repository/`; commands and services never embed SQL.
- Queries use runtime `sqlx::query`/`query_as` (not `query!` macros), so
  builds do not need `DATABASE_URL` or `sqlx prepare`.
- Imports upsert by `path`; a re-scan updates metadata instead of
  duplicating rows.
- Tests always create the pool in a `tempfile` temp dir.

## Reconciliation rules (milestone 3)

The watcher reconciles toward **path truth**: after a batch settles, every
book file inside a watched location has exactly one `available = 1` row with
that path, and rows whose files vanished have `available = 0`. Rules:

- Removals never delete rows; they only flip availability (prefix-aware:
  removing a directory marks everything beneath it).
- Renames/moves relink the existing row by id (`relink_book`), so reading
  progress and collections survive. A rename whose destination path is
  owned by another row resolves by fs truth (content import + old path
  unavailable).
- When the destination half of a rename event is lost (watch registered a
  moment too late) the move is recovered during reconciliation sweeps by
  relinking the book whose stored file vanished and whose name+size match
  the unknown file — a copied file (source still on disk) is imported as a
  new book instead.
- Modification events re-parse only when the stored size/mtime snapshot
  differs; duplicate/touch events are no-ops.
