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

| column           | type                                    | notes                                               |
| ---------------- | --------------------------------------- | --------------------------------------------------- |
| id               | INTEGER PK AUTOINCREMENT                |                                                     |
| path             | TEXT NOT NULL UNIQUE                    | absolute file path                                  |
| title            | TEXT NOT NULL, CHECK non-blank          | source title of this file                           |
| subtitle         | TEXT                                    | source subtitle                                     |
| author           | TEXT                                    | source display projection of the file's author list |
| publisher        | TEXT                                    | source publisher                                    |
| language         | TEXT                                    | source language                                     |
| isbn             | TEXT                                    | source ISBN                                         |
| description      | TEXT                                    | source description                                  |
| cover_path       | TEXT                                    | extracted cover image file from this copy           |
| added_at         | TEXT NOT NULL, DB default               | set by INSERT                                       |
| modified_at      | TEXT NOT NULL, DB default               | bumped on UPDATE                                    |
| available        | INTEGER NOT NULL DEFAULT 1              | 0 once the file disappears                          |
| file_size        | INTEGER NOT NULL DEFAULT 0              | bytes at last import                                |
| file_mtime       | INTEGER NOT NULL DEFAULT 0              | unix seconds at last import                         |
| publication_date | TEXT                                    | source publication date                             |
| series_id        | INTEGER, FK `series` ON DELETE SET NULL | source series membership                            |
| series_index     | REAL                                    | source position inside the series                   |
| book_uid         | TEXT                                    | durable book identity (see below)                   |
| hash_state       | TEXT NOT NULL DEFAULT 'pending'         | `pending`, `hashed`, or `failed`                    |

A `books` row is a **file** in the library. Its bibliographic columns are the
source values from the last parse of that file; the durable book record holds
the effective view (user overrides merged over source). `series_name` is not a
column: book queries LEFT JOIN the `series` table.

`available`/`file_size`/`file_mtime` back the filesystem watcher (milestone
3): a disappeared file marks `available = 0` but never deletes the row
(metadata, collections, and reading progress are preserved for
reconnection), and the size/mtime snapshot lets the watcher distinguish
real modifications from duplicate events without re-parsing documents.

`book_uid` names the durable book record this file belongs to (more than one
file may share it). `hash_state` is the durable progress of the background
content-hash pass: `pending`, `hashed`, or `failed`.

## Durable book records (migrations 0017–0019)

ADR 0014 separates the durable **book** from the **file** that happens to
contain it. Migration 0017 built the identity foundation; 0018 moved reading
progress and annotations onto the book; 0019 moved collection membership,
metadata overrides, effective metadata, and last-opened. The public numeric
book id is `book_records.id`; a file row is a location, and the reader
resolves the active file from the durable book.

- `book_records` — one row per durable book, with a stable numeric `id`, a
  random 128-bit `uid`, the **effective** bibliographic columns (title
  through `series_id`), `last_opened_at`, a progress snapshot, an annotation
  count, and `metadata_state` (`available` / `waiting_for_file`). File rows
  that already shared a sync uuid collapse into one record. A book with no
  file keeps its last effective snapshot for Reading history. Deleting the
  last file row keeps the record.
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
- `migration_issues` — failures that still need a relink. A failed content
  hash is recorded here and the book keeps its record. Identity merges and
  duplicate-state unions are automatic and no longer recorded: earlier
  versions left informational rows (`identity_merged`,
  `duplicate_state_merged`, `duplicate_identity`), and migration 0026 resolves
  those on upgrade.

When duplicate file rows collapse into one durable book, migration 0019 and
`sync::identity::merge_book_identity` agree on the rules: collection
membership unions, annotations union, and the newest last-opened and metadata
overrides win. Metadata overrides have no timestamp of their own, so the
newest file row's `modified_at` is the ordering signal; a tie keeps the
current winner. Runtime identity merges keep their audit trail in
`sync_book_merges`; upgrade-time unions keep the resolved rows above.

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

Join table, PK `(book_uid, collection_id)`. `book_uid` is FK
`book_records` and `collection_id` is FK `collections`, both with
`ON DELETE CASCADE`. Membership belongs to the durable book, so Remove and
Unwatch never remove a shelf entry; deleting the book record (Forget) or the
collection does.

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

## Provider links (migration 0021)

Third-party links belong to the durable book, so they survive every file row
leaving the library (ADR 0014 D11, [PROVIDERS.md](PROVIDERS.md)).

- `book_provider_links` — one row per `(book_uid, provider)`: `remote_id`, the
  provider's cached `status` (`want_to_read`, `reading`, `paused`, `finished`,
  or `dropped`; NULL until reported), `status_updated_at`, `linked_at`, and
  `updated_at`. `book_uid` is a FK to `book_records` with cascade, and
  `(provider, remote_id)` is unique.
- `book_provider_pending_progress` — at most one queued local page-turn per
  link (`book_uid`, `provider`, `progress_percent`, `queued_at`). It has a
  composite FK to `book_provider_links` with cascade. Remote updates never
  write here, and the write is skipped when the book has no file row.

The cached status is provider data, not a second TuxBooks reading status.
Reading status remains `reading_progress`; a `finished` remote status maps to
`progress_percent = 100`.

## Cross-edition links (migration 0024)

A confirmed cross-edition relink records that two durable books are
different editions of one work (ADR 0014 D9, ticket tuxbooks-ip6.8). It is a
relation, never a merge: both books keep their own `book_records` row, file
rows, progress rows, and annotations.

- `book_edition_links` — `book_uid_a`, `book_uid_b`, and `linked_at`. The pair
  is stored in deterministic order (`book_uid_a < book_uid_b`, enforced by a
  CHECK), so one relation has one row whichever book is opened first. Both
  columns cascade when a durable book is forgotten. The relation is local for
  now; it has no sync capture or projection.
- `link_book_edition` copies the source `progress_percent` into the target as
  a percentage-only row, replacing any position or locator the target already
  had. No CFI, chapter href, page, progression, locations JSON, engine marker,
  or locator is copied. A PDF reader resolves the percentage to the nearest
  page; the EPUB reader already restores a percentage-only row.
- Provider links and their cached status move from the source to the target,
  together with any queued page-turn. If the target already has a link for
  the same provider, the command rejects the whole operation with an explicit
  conflict instead of overwriting it. Annotations and collection membership
  never move.
- `list_book_editions` returns the other side of the relation, including
  whether that edition is currently in the library or in Reading history.
- This slice has no standalone unlink command: forgetting either book drops
  the relation through the cascade. The link is informational only, so an
  unlink can be added later without migrating data.

## Reset, Forget, and the book trash (migration 0022)

ADR 0014 D5 makes the two destructive actions explicit and different:

- **Reset reading data** clears `reading_progress`, `annotations`,
  `book_collections`, `book_metadata_overrides` (and the customized
  author/subject lists), and `book_provider_links` for one durable book, then
  recomputes effective metadata from the source file. The `book_records` row
  and every file row stay, so the library entry keeps its identity and file
  and becomes unread.
- **Forget book** snapshots the whole durable record and its state into
  `book_trash`, unlinks each provider through `unlink_provider_book`, deletes
  every `sync_book_aliases` row for the old uid, and deletes the old
  `book_records` row. When a file row exists, it is rebound (not deleted and
  re-imported) to a fresh `book_records` row with the same effective source
  metadata, so the library entry never disappears; the current content hash
  alias moves to the fresh uid. With no file row there is no fresh identity,
  the old record is simply deleted, and the book leaves Reading history.
- `book_trash` — `book_id`, `book_uid`, `replacement_book_uid` (the fresh
  identity, NULL when there was no file), `snapshot_json` (the old record,
  progress, annotations, collection membership, overrides, lists, provider
  links, and aliases), `deleted_at`, `expires_at`, `restored_at`, and
  `resolution` (`restore`, `discard`, or NULL while open). A partial unique
  index keeps one open row per identity. The 30-day window matches annotation
  and collection deletes, but the table is deliberately separate from
  `sync_trash`: one row here is a whole book, not one sync entity.
- Restore looks up `replacement_book_uid`. If that fresh book has no progress
  and no annotations, the old record and state are restored and the fresh
  record is deleted. If it has new progress or annotations, the command
  returns a conflict instead of merging silently; Replace restores the old
  record, Keep discards the snapshot, and Merge keeps the newer progress and
  unions annotations on the current identity. A book forgotten without a file
  restores directly into Reading history.

## Metadata curation (milestone 7)

Milestone 7 keeps two layers so a book's curated metadata can never lose
the file's own values, while one Save writes the fields the format supports
into the file:

1. `book_source_metadata` — **file truth**, one row per file row, refreshed
   by the importer on every (re)import, by the reconnect flow, and by every
   save that rewrites the file. `authors`/`subjects` are JSON arrays (NULL
   = pre-normalization backfill, treated as empty); `cover_path` is the
   extracted cover at import time. The `books` source columns hold the same
   values as a fallback for rows that predate the snapshot.
2. `book_metadata_overrides` — **user truth**, one row per durable book
   (`book_uid`, FK `book_records`). `NULL` = inherit the source value; an
   empty string = explicitly cleared. `cover_path` overrides the extracted
   cover. `authors_customized`/`subjects_customized` gate whether a
   re-import may replace the normalized lists (0 = follow the file,
   1 = the user owns the list).
3. `book_records` effective columns — the **effective view** every reader
   path consumes, recomputed by `repository/metadata.rs::recompute_effective`
   after imports, edits, resets, and cover changes. The FTS triggers then
   keep the search index in sync automatically.

A book with several file rows takes its source values from the most recently
refreshed file (`books.modified_at`), so re-importing a duplicate refreshes
the effective view without touching the user's overrides. Source metadata
stays per file; `get_book_metadata` reports that primary file's source.

### Normalized entities

- `authors` (shared vocabulary, UNIQUE name) + `book_authors` (join table
  keyed by `book_uid`, with a `position` for display order).
  `book_records.author` is a maintained display projection (joined with
  `", "`) so FTS and list views keep working unchanged.
- `subjects` + `book_subjects` (keyed by `book_uid`).
- `series` + `book_records.series_id`/`book_records.series_index`. Source and
  override series are stored by name in their layers; the effective name is
  resolved to a shared `series` row id. Series/author/subject rows no book
  references are swept (`sweep_orphans`) after edits, resets, and removals.
- Collection membership stays in `collections`/`book_collections`, now
  keyed by `book_uid`.

### Merge and override rules

Implemented once in `repository/metadata.rs::recompute_effective`:

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

Deleting a durable book (Forget) cascades its overrides, lists,
membership, progress, and annotations; deleting its file rows also removes the
per-file source snapshots. Removing a file row (Remove, Unwatch) leaves the
durable book, and therefore its progress, annotations, collection membership,
metadata overrides, customized lists, and last-opened, in place. No user-state
table has a foreign key to `books`.

## Full-text search

`books_fts` is an FTS5 table over
`book_records(title, subtitle, author, publisher, isbn, description)` plus the
active file's `path`. It is a regular (not external-content) index because the
metadata owner and the path live in different tables: a trigger on
`book_records` refreshes the metadata columns, and triggers on `books`
refresh the path when a file is added, moved, made unavailable, or removed.
Migration 0019 rebuilt the index and dropped the old external-content
triggers; migration 0020 keeps a durable book indexed after its last file
row is removed (with a NULL path), so Reading history is searchable too.
Search code joins `books_fts.rowid = book_records.id`; library results join
the active file so Reading-history books are excluded, and Reading-history
results require the absence of a file. Both use
`snippet(…, -1, …)` (automatic column: the snippet comes from whichever column
matched best). The path column doubles as the file-name field — the tokenizer
splits on `/` and `.`, so bare file-name tokens match. If you change the
indexed `book_records` or `books` columns, update those triggers — the test
`updating_book_keeps_fts_index_in_sync` must keep passing.

User queries never reach FTS5 raw: `services/search.rs`
(`build_fts_query`) strips quotes and turns whitespace-separated tokens
into quoted prefix phrases ANDed together (`wind river` →
`"wind"* "river"*`), so input cannot inject MATCH syntax.

## Shared Forget (migration 0023)

The local trash row is the durable record of a Forget; the sync mirror keeps
the remote side:

- `sync_book_trash` — one row per forgotten `book_uid`: the portable
  `snapshot_json` (collection memberships by collection uid, provider links
  omitted), `replacement_book_uid`, the delete clock, the 30-day window,
  `restored_at`, `discarded`, and the restore clock. A missing snapshot is
  allowed so a delete always propagates; the receiver records a Sync issue
  instead of offering a fake restore.
- A `book` entity in `sync_state_entities` carries the tombstone. It does not
  invent tombstones for annotations or progress: the book tombstone is the
  authority, and stale operations for a forgotten uuid are ignored.
- Triggers on `book_trash` insert/restore write the `book` marker into
  `sync_dirty`, so Forget and restore work with sync off and drain when a
  folder is connected later.
- Alias selection and identity merges refuse a uuid that has an open Forget
  row. That is what stops `sync_book_aliases` and stale `sync_book_merges`
  edges from resurrecting the old identity.

## Conflict review (migration 0027)

`sync_conflicts` records the value a last-writer-wins merge discarded, with both
JSON values, both hybrid clocks, and the devices that wrote them. Migration
0027 adds `resolved_at` and an index on it. The applied winner is never rolled
back by the row itself; the queue only records what was lost.

- A resolved row keeps `resolved_at` for the audit trail and leaves the open
  count. `keep_winner` only stamps it. `apply_loser` publishes the discarded
  value as a normal operation with a fresh clock, so every device converges;
  delete/edit (`__deleted__`) and lost restores (`__restore__`) republish the
  explicit restore operation instead.
- An unresolved row older than 30 days is deleted during a status refresh or a
  conflict list, matching the trash window. Its `sync_issues` row closes when
  no other open conflict shares the key.
- Several losing writes for one `(kind, entity_uid, field)` share one issue and
  one key. The issue is resolved only after the last of them is settled.
- Book identity conflicts are keep-only because identity merges are
  deterministic; a whole-book record conflict is settled from Reading history.

## Cloud-folder sync (migration 0015)

The sync engine keeps its bookkeeping in the same SQLite file. Reading
progress, annotations, metadata overrides, collection membership, and
last-opened are keyed by the durable book uid; a file row is only a
location. Nothing here changes how imports, readers, or search work. The
full contract is [SYNC.md](SYNC.md).

- `sync_meta` — device id/name, folder path, library id, enabled flag, baseline
  flag, last sync, last error, and the hybrid logical clock.
- `sync_dirty` — one row per entity with a pending local change. Triggers write
  the canonical snapshot at change time (`old_json`/`new_json`); the capture
  pass drains it. Progress, metadata, last-opened, and book lifecycle key on
  `book_uid`; annotations carry `book_uid` directly; membership keys on
  `book_uid:collection_id`. Triggers skip a vanished collection's cascade (a
  local deletion, not a shared delete).
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
  losing field values with their resolution and 30-day expiry, and the 30-day
  delete restore list for single entities.
- `sync_book_trash` — whole-book Forget snapshots, clocks, and the remote
  restore/discard state. Separate from per-entity `sync_trash` (migration 0023).
- `sync_ignored_books` — local-only hiding of books whose shared state is
  waiting for a file. The mirror state stays so importing the exact bytes can
  still attach it (migration 0025).
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
  in `book_source_metadata` for that file and re-merges the durable book's
  effective view (`repository::metadata::record_imported_source`), so user
  overrides survive file changes (milestone 7).
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
