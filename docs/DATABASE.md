# Database

SQLite (bundled, via SQLx) at a single file path. Migrations live in
`sidecar/migrations/` and are embedded at compile time with
`sqlx::migrate!`; they run automatically in `db::connection::init_pool`,
so a clean database always converges to the current schema. Add numbered
`.sql` files; never create schema procedurally at runtime.

Location: OS app-data dir (`tuxbooks.db`) unless `TEST_DATABASE_PATH` is
set. Timestamps are RFC 3339 TEXT (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
and `foreign_keys` is forced ON for every connection.

## Tables

### books

| column           | type                                    | notes                                                |
| ---------------- | --------------------------------------- | ---------------------------------------------------- |
| id               | INTEGER PK AUTOINCREMENT                |                                                      |
| path             | TEXT NOT NULL UNIQUE                    | absolute file path                                   |
| title            | TEXT NOT NULL, CHECK non-blank          |                                                      |
| subtitle         | TEXT                                    |                                                      |
| author           | TEXT                                    | display projection of the author list (see metadata) |
| publisher        | TEXT                                    |                                                      |
| language         | TEXT                                    |                                                      |
| isbn             | TEXT                                    |                                                      |
| description      | TEXT                                    |                                                      |
| cover_path       | TEXT                                    | extracted cover image file                           |
| added_at         | TEXT NOT NULL, DB default               | set by INSERT                                        |
| modified_at      | TEXT NOT NULL, DB default               | bumped on UPDATE                                     |
| last_opened_at   | TEXT NULL                               | set when reading starts                              |
| available        | INTEGER NOT NULL DEFAULT 1              | 0 once the file disappears                           |
| file_size        | INTEGER NOT NULL DEFAULT 0              | bytes at last import                                 |
| file_mtime       | INTEGER NOT NULL DEFAULT 0              | unix seconds at last import                          |
| publication_date | TEXT                                    | effective (override over source)                     |
| series_id        | INTEGER, FK `series` ON DELETE SET NULL | effective series membership                          |
| series_index     | REAL                                    | position inside the series                           |
| book_uid         | TEXT                                    | durable book identity (see below)                    |
| hash_state       | TEXT NOT NULL DEFAULT 'pending'         | `pending`, `hashed`, or `failed`                     |

The bibliographic columns hold the **effective** metadata — user overrides
(milestone 7) merged over the source-file values. `series_name` is not a
column: book queries LEFT JOIN the `series` table.

`available`/`file_size`/`file_mtime` back the filesystem watcher (milestone
3): a disappeared file marks `available = 0` but never deletes the row
(metadata, collections, and reading progress are preserved for
reconnection), and the size/mtime snapshot lets the watcher distinguish
real modifications from duplicate events without re-parsing documents.

`book_uid` names the durable book record this file belongs to (more than one
file may share it). `hash_state` is the durable progress of the background
content-hash pass: `pending`, `hashed`, or `failed`.

## Durable book records (migrations 0017–0018)

ADR 0014 separates the durable **book** from the **file** that happens to
contain it. Migration 0017 built the identity foundation; migration 0018 makes
reading progress and annotations survive the file leaving the library. The
public numeric book id is `book_records.id`; a file row is a location, and the
reader resolves the active file from the durable book.

- `book_records` — one row per durable book, with a stable numeric `id`, a
  random 128-bit `uid`, a metadata snapshot, `last_opened_at`, a progress
  snapshot, an annotation count, and `metadata_state`
  (`available` / `waiting_for_file`). File rows that already shared a sync
  uuid collapse into one record. The snapshot is authoritative only for a
  book with no file; a book with a file reads its effective metadata from
  the file row, and triggers keep the snapshot in step. Unlike the 0017
  slice, deleting the last file row keeps the record.
- `books.book_uid` — the file's durable book. The migration reuses the uuid
  from `sync_book_bindings` when one exists, otherwise it generates one.
  `book_uid` is not UNIQUE: duplicate copies and moves are several files for
  one book.
- `books.hash_state` — `pending` before a file is hashed, `hashed` after the
  content hash is bound, and `failed` when the file cannot be read. New
  imports hash before they are published; the background pass resumes the
  backfill after a restart. Remove and Unwatch finish any pending hash for
  the affected file rows first, so a re-import can reattach; a failed hash is
  recorded as a relink issue and does not block the action.
- `migration_issues` — visible merges and failures: two file rows that
  shared a uuid, two hashes that turned out to be the same book, duplicate
  progress that was unioned, and a book whose hash failed and now needs a
  relink. The Application Data settings tab lists open issues and can dismiss
  them.

The upgrade takes a **pre-migration backup** before applying pending
migrations: `VACUUM INTO` writes `<db>.pre-migration-<timestamp>.bak` beside
the database, so uncheckpointed WAL frames are included. The backup stays
after a successful start. A migration or backup failure is fail-closed: the
original database is left in place, the error is returned to startup, and
the file is **not** quarantined or replaced with an empty library. A failed
`PRAGMA quick_check` or an unreadable file is still treated as corruption and
quarantined as before.

The upgrade also recovers identity the sync mirror still holds for books
that were unwatched before the upgrade: a `book_records` row is created for
each mirrored uuid with no file, using the mirrored metadata, progress, and
annotation count when present. A record with no metadata is labelled
`waiting_for_file`; state that never reached the mirror is not recoverable.

### library_locations

`id`, `path` (UNIQUE), `added_at`. The filesystem roots registered by
`import_paths` (a folder import, or the parent of a picked file), by
`scan_library`, or by the test seeding; only these are watched and
reconciled. Unwatching a folder deletes its row, which is what stops the
sync, and ends the library membership of the file rows it owns. The durable
book and its reading progress and annotations stay (ADR 0014 D4); files on
disk are never touched. Books outside watched locations are never touched by
reconciliation — a fresh database that predates milestone 3 stays unwatched
until the next import.

### collections

`id`, `name` (UNIQUE), `created_at`.

### book_collections

Join table, PK `(book_id, collection_id)`, both FK with
`ON DELETE CASCADE`.

### reading_progress

PK `book_uid` (FK `book_records`, cascade) — one progress row per durable
book, so it survives every file leaving the library.
`chapter_href`, `cfi`, `character_offset`, `page_number`, `scroll_offset`,
`progress_percent` (REAL, CHECK 0..=100 or NULL), `updated_at`. The reader
writes the format-specific locators it tracks; `progress_percent` is the
coarse shell position that backs the library's "In Progress" /
"Finished" sections, and `mark_finished` (milestone 10) sets it to 100
without disturbing the stored locators.

Progress rows are user data and are migrated, never reset, when the
rendering engine changes (foliate → Readium, see `docs/EPUB.md`). The migration is versioned and idempotent:
a schema/engine version marks which rows have been converted, the original
locator values are preserved until the new ones are validated, and a
per-book completion marker prevents re-running. New columns for the
migration are added by an embedded numbered migration, like any schema
change.

### annotations

One row per persistent reading annotation (milestone 6): bookmarks,
highlights, the short bookmark label, and the note attached to either (1:1
through the nullable `note` column — there is no separate notes table).

| column        | type                                               | notes                                                         |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| id            | INTEGER PK AUTOINCREMENT                           |                                                               |
| book_uid      | TEXT NOT NULL, FK `book_records` ON DELETE CASCADE | durable book, not the file row                                |
| kind          | TEXT NOT NULL, CHECK `bookmark`\|`highlight`       |                                                               |
| cfi           | TEXT                                               | canonical EPUB CFI (bookmarks and highlights)                 |
| chapter_href  | TEXT                                               | spine href of the EPUB section (display grouping)             |
| page_number   | INTEGER, CHECK >= 1                                | 1-based PDF page                                              |
| page_fraction | REAL, CHECK 0..=1                                  | optional page-local anchor (PDF bookmarks)                    |
| text          | TEXT                                               | selected text (highlights; mandatory for EPUB, optional PDF)  |
| color         | TEXT                                               | highlight palette key (`yellow`, `green`, …)                  |
| geometry      | TEXT                                               | JSON array of rects normalized to page space (PDF highlights) |
| label         | TEXT, CHECK <= 50 characters                       | short bookmark label (bookmarks only)                         |
| note          | TEXT                                               | the attached note (empty string = no note text)               |
| created_at    | TEXT NOT NULL, DB default                          |                                                               |
| modified_at   | TEXT NOT NULL, DB default                          | bumped on UPDATE                                              |

Locator invariant: every row names one stable document position — a CFI or
a page number — never UI pixels. PDF highlight `geometry` is stored
normalized to page space (`0..1` per axis, validated by the service), so
highlights redraw correctly at any zoom or window size. Index on
`(book_uid, kind)`; deleting the durable book cascades, while removing a file
row does not.

## Metadata curation (milestone 7)

Milestone 7 keeps two layers so a book's curated metadata can never lose
the file's own values, while one Save writes the fields the format supports
into the file:

1. `book_source_metadata` — **file truth**, one row per book, refreshed by
   the importer on every (re)import, by the reconnect flow, and by every
   save that rewrites the file. `authors`/`subjects` are JSON arrays (NULL
   = pre-normalization backfill, treated as empty); `cover_path` is the
   extracted cover at import time.
2. `book_metadata_overrides` — **user truth**, one row per book (created by
   migration 0008 for existing rows). `NULL` = inherit the source value;
   an empty string = explicitly cleared. `cover_path` overrides the
   extracted cover. `authors_customized`/`subjects_customized` gate whether
   a re-import may replace the normalized lists (0 = follow the file,
   1 = the user owns the list).
3. `books` columns — the **effective view** every reader path consumes,
   recomputed by `services/metadata.rs` after imports, edits, resets, and
   cover changes. The FTS5 triggers then keep the search index in sync
   automatically.

### Normalized entities

- `authors` (shared vocabulary, UNIQUE name) + `book_authors` (join table
  with a `position` for display order). `books.author` is a maintained
  display projection (joined with `", "`) so FTS and list views keep
  working unchanged.
- `subjects` + `book_subjects`.
- `series` + `books.series_id`/`books.series_index`. Source and override
  series are stored by name in their layers; the effective name is
  resolved to a shared `series` row id. Series/author/subject rows no
  book references are swept (`sweep_orphans`) after edits, resets, and
  removals.
- Collection membership stays in `collections`/`book_collections`
  (unchanged since milestone 3).

### Merge and override rules

Implemented once in `services/metadata.rs::recompute_and_apply`:

- Scalar fields: override `NULL` → source value; `Some("")` → cleared;
  `Some(v)` → `v`.
- Series travels as one unit (name + index): an overridden unit owns both
  values; clearing the name clears the index; an inherited unit takes both
  from the source.
- The minimal-override persist (`apply_form`, shared by the save/embed
  path) stores an override only where the form differs from the source —
  typing the original value back removes the override. The cover override
  always wins over the extracted cover until cleared or reset.

### Embedding into the source file

Saving is the embed: `embed_book_metadata` persists the submitted form
(apply_form's minimal-override rule), rewrites the effective text metadata
into the file (EPUB OPF metadata; PDF `/Title`, `/Author`, `/Subject`)
atomically, re-parses the file, and records the result as the new source
snapshot. Overrides for fields the format can carry are then cleared (the
file is authoritative); fields the format cannot hold — e.g. a PDF series/
subtitle — keep their override, so the effective view is unchanged. Covers
are never embedded: the artwork cache stays the only cover store. Before
the first write, a one-time `<file>.bak` copy of the original is kept beside
the book (`<file>.epub.bak` / `<file>.pdf.bak`; the `.bak` extension is
never scanned into the library). TuxBooks never deletes or overwrites an
existing backup. If the book folder is cloud-synced, the client carries the
backup with the book; see `docs/SYNC.md`. The re-parse also updates the FTS index
through the normal effective-column triggers. `reset_book_metadata` drops
every override, returning the book to its source-file metadata; with no
overrides left, the reset affordance disables itself.

Deleting a durable book cascades to all of these tables. Removing a file row
(Remove, Unwatch) leaves the durable book and its progress and annotations in
place; collection membership and metadata overrides still hang off the file
row until ticket `tuxbooks-ip6.4`.

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

## Cloud-folder sync (migration 0015)

The sync engine keeps its bookkeeping in the same SQLite file. The catalog
tables stay path-keyed; reading progress and annotations are keyed by the
durable book uid. Nothing here changes how imports, readers, or search work.
The full contract is [SYNC.md](SYNC.md).

- `sync_meta` — device id/name, folder path, library id, enabled flag, baseline
  flag, last sync, last error, and the hybrid logical clock.
- `sync_dirty` — one row per entity with a pending local change. Triggers write
  the canonical snapshot at change time (`old_json`/`new_json`); the capture
  pass drains it. Cascades caused by a vanished book or collection are skipped
  by the triggers.
- `sync_state_entities` / `sync_state_fields` — the materialized shared state.
  Entities carry tombstones and entity-level clocks; fields carry one value and
  one clock each.
- `sync_book_aliases` / `sync_book_bindings` — content hash to shared uuid, and
  local book row to shared uuid with the hash snapshot used to detect rewrites.
- `sync_book_merges` / `sync_entity_merges` — deterministic identity merges
  (smallest uuid wins) so replay order cannot resurrect a losing id.
- `sync_ops` / `sync_applied_ops` — locally emitted operations and every applied
  operation id. `sync_remote_files` caches file size/mtime and retry counts so a
  pass only reads new or changed files.
- `sync_issues` / `sync_conflicts` / `sync_trash` — user-visible failures,
  losing field values, and the 30-day delete restore list.
- `sync_reproject` — book uuids whose canonical local row was deleted. The
  engine projects the shared state onto the next bound row, so a duplicate
  copy does not look empty after the first copy is removed.
- `books.rehash_pending` — set before a metadata embed rewrites the file and
  cleared after the size/mtime snapshot is refreshed. The identity sweep treats
  it as a forced rehash, which closes the crash window between the rewrite and
  the snapshot update.

`annotations.sync_uid` and `collections.sync_uid` are the portable entity ids;
existing rows are backfilled in the migration. The sync worker fills a null uid
on first use, so a row created while sync is off is never a constraint error.

## Conventions

- All SQL lives in `repository/`; commands and services never embed SQL.
- Queries use runtime `sqlx::query`/`query_as` (not `query!` macros), so
  builds do not need `DATABASE_URL` or `sqlx prepare`.
- Imports upsert by `path`; a re-scan updates metadata instead of
  duplicating rows. After the upsert, the importer records the fresh parse
  in `book_source_metadata` and re-merges the effective view
  (`services::metadata::apply_source_metadata`), so user overrides survive
  file changes (milestone 7).
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
