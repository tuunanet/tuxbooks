# ADR 0014: Durable book records own reading state

Status: accepted
Date: 2026-10-29
Decides: what owns reading progress, annotations, collections, metadata overrides, last-opened, and provider links; what Remove, Unwatch, Reset, and Forget do; how a book is re-identified when its file returns
Relates to: ADR 0008 (unwatch removes books), ADR 0013 (cloud-folder sync), `CONTEXT.md` (Book, Book file, Library membership, Reading history, Book identity)
Supersedes: ADR 0008

## Context

A catalog row currently carries three unrelated responsibilities: it is a file
inside a watched folder, it owns user-authored state, and it caches
bibliographic metadata. `unwatch_locations` collects the rows a folder owns and
calls `delete_book`, which is a plain `DELETE FROM books`; the foreign keys take
`reading_progress`, `annotations`, `book_metadata_overrides`, `book_collections`,
and `sync_book_bindings` with it. ADR 0008 chose that behaviour on purpose and
made the unwatch dialog warn that progress and annotations go with the books.
The library's own Remove path uses the same cascade, and its dialog does not
warn.

That choice made sense while unwatch was rare and the catalog was the only home
of user state. It does not survive two later facts:

1. Users reorganize folders. Unwatching and re-watching a folder is a normal
   library operation, not a destructive reset, and a move inside a watched
   folder already imports the file as a fresh row. The importer has a test
   asserting exactly that (`moved_file_reimport_reuses_cached_cover`).
2. ADR 0013 already decided that a local disappearance is not a shared delete.
   The sync mirror keeps progress and annotations for a book that is not
   present and projects them back when the content returns. But the sync engine
   only runs when a sync folder is configured; with sync off, the cascade is
   the only outcome.

Issue #281 adds a third pressure. A Hardcover link, reading status, and queued
progress updates must outlive a local file, or the next sync can push a blank
or stale state for a book the user is still reading elsewhere.

The catalog row cannot be the owner of state that must survive the row's
deletion. A durable book record and a transient library membership have to be
separate things.

## Decision

### D1. A book is durable; a file is a location

A **book** is the unit that owns reading progress, annotations, collection
membership, metadata overrides, last-opened, and provider links. It has a
stable identity and exists whether or not a file is currently in the library.

A **book file** is a copy of the book at an absolute path, with its own size,
mtime, availability, and source metadata. A **library membership** is a book
having at least one file inside a watched folder (or a single-file import that
watches its parent).

The library remains a view over current memberships. Unwatching a folder or
removing a book deletes file rows and memberships, never the durable book. A
book with no file row appears in **Reading history**, not in the library.

### D2. Identity is a local uuid with content-hash aliases

Every book gets a random 128-bit `book_uid` at import. The SHA-256 of the file
bytes is a discovery key, not the identity: a metadata embed rewrite keeps the
uuid and adds the new hash as another alias. The existing sync identity tables
already model this; the uuid becomes the local owner key too.

An import whose content hash matches an alias attaches a file to the existing
book instead of creating a new one. This is what makes a move, an unwatch and
re-watch, and a duplicate copy reattach automatically. EXACT bytes are the
automatic rule.

ISBN, title and author are not automatic merge keys. They may drive a
user-confirmed relink or a provider match. Two different editions are two
books; a confirmed relink links them and copies progress as a percentage, but
does not merge identities and does not move annotations (D9).

### D3. Local durable tables are the source of truth

User state lives in local tables keyed by `book_uid`. They are authoritative
whether sync is on or off. The sync mirror (`sync_state_entities` /
`sync_state_fields`) remains the merged remote cache and the place where clocks
and conflict resolutions live; projection writes into the local durable tables.
The engine may capture and project locally without a folder, but no feature
depends on the mirror being the only copy of state.

On upgrade with sync enabled, existing mirror state and clocks are preserved.
The upgrade is not a fresh baseline and must not re-export local state with new
clocks that could overwrite newer remote values.

### D4. Local disappearance preserves state

Unwatch, Remove, and a file that disappears from disk all preserve the durable
book and every piece of user state attached to it. They delete or mark only the
file row and its membership. No local disappearance emits a shared delete.

The unwatch and Remove dialogs say that reading data is kept. The old warning
that progress and annotations are destroyed is removed.

### D5. Reset and Forget are explicit and different

**Reset reading data** clears progress, annotations, collection membership,
metadata overrides, and provider links, but keeps the book identity and the
current file. The book stays in the library as unread.

**Forget book** erases the identity: the old book and its state move to the
30-day trash, hash aliases are removed, and the current file (if any) is
rebound to a fresh book identity. Keeping the file row and rebinding it avoids
a re-import race: the library entry never disappears, and a restore always has
exactly one current book to attach to.

Restoring a Forgotten book:

- if the fresh book has no new state, restore the old record and delete the
  fresh one silently;
- if the fresh book has new progress or annotations, offer Replace (old data
  wins), Keep (current data wins), or Merge (newer progress, union of
  annotations).

Forget unlinks providers but does not ask them to delete their remote history.
With sync enabled, Forget is a shared delete. Ordinary annotation and
collection deletes keep their existing 30-day trash; Forget uses the same
window for the whole book.

### D6. Reading history is a first-class view

Books with no file row appear in a separate **Reading history** view. It shows
the durable metadata snapshot, progress, annotation count, and provider link,
and offers Relink and Forget. The library stays membership-only. A book whose
file is missing but whose file row still exists inside a watched folder stays
in the library as unavailable, which is the existing behaviour.

Reading history is not the retired loose-book mechanism. A loose book was a
catalog row outside every watched folder and could appear in library views. A
Reading history entry is a durable book with no file; library queries never
return it.

### D7. One library entry per book

A book can have several file rows, including exact-duplicate copies. The
library shows one entry per book, with duplicate locations on the book details
and in storage reporting. This keeps two entries from displaying the same
progress and makes "the same book in two folders" a property of one record.

### D8. Hashing is guaranteed before a file can disappear

New imports compute the content hash as part of import. Existing books are
hashed by a resumable background job after migration, with progress in
Settings. Remove and Unwatch wait for pending hashes on the affected books; a
failed hash marks the book "needs relink" instead of blocking the action.
Destructive actions never delete the last file of a book whose hash is unknown.

### D9. Confirmed cross-edition relinks do not merge state

A user-confirmed relink between different editions keeps two durable books
linked as editions. It copies reading progress as a percentage (no locator),
moves the provider link and reading status to the current edition, and leaves
annotations with the original book. The new edition starts without annotations.
Text-anchored annotation migration is a later feature.

### D10. Migration is backed up and fails closed

The schema change rebuilds every user-state table. Before running it, take a
consistent backup of the catalog. If the migration fails, stop startup with a
clear error and leave the original database in place; do not quarantine it and
start with an empty library. Keep the backup until the new schema has started
successfully at least once.

Existing books get a `book_uid` immediately. Books that already share a uuid
collapse into one durable book; books that discover the same content hash later
merge with newest progress winning, annotations and collection membership
unioned, metadata overrides newest winning, and a migration issue recording the
merge. That last part is revised: merges are silent now. The losing state still
moves to the winner, but no migration issue is recorded; `sync_book_merges`
keeps the audit trail, and migration 0026 resolves the informational rows older
versions left open. State that the sync mirror still holds for books unwatched
before the upgrade is recovered best-effort; metadata may be missing and the
record is labelled waiting for its file. State already cascaded away with sync off cannot
be recovered.

### D11. Provider links hang off the book

A provider link, remote id, reading status, and sync queue entry key on
`book_uid`, never on a file row. An absent book keeps its link and last known
status, accepts remote updates into durable state, and emits no page-turn
updates until a file is open. Forget unlinks. This is the contract #281 builds
on.

## Considered options

- **Keep the destructive cascade and warn harder.** Rejected. Folder
  reorganization is a normal operation; a warning does not make data loss
  acceptable, and sync-off users have no recovery.
- **Soft-delete catalog rows with a `removed_at` flag.** Rejected. It keeps the
  catalog conflating membership with identity, and every library query has to
  remember the filter. The old loose-book mechanism was retired for the same
  reason.
- **Promote the sync mirror to an always-on local store.** Rejected. It makes
  the sync subsystem mandatory for every user, leaves state split between local
  rows and the mirror, and turns a transport concern into the owner of local
  data.
- **Key user state by content hash.** Rejected. A metadata rewrite would create
  a new book; the hash is a discovery key.
- **Key user state by path.** Rejected. A move is exactly the case that must
  keep state.
- **Add a Work/Edition hierarchy now.** Rejected for v1. A user-confirmed
  edition link covers the immediate need; a work entity can be added when
  provider matching demands it.

## Consequences

- A forward-only schema migration splits the catalog into durable book records
  and file rows, re-keys every user-state table by `book_uid`, moves effective
  metadata to the book record and source metadata to the file, and rebuilds the
  search index over book records.
- The public numeric `bookId` remains, but it now names the durable book record,
  not the file row. The reader resolves the active file from the book. This
  keeps most frontend call sites and the bridge contract stable.
- Sync triggers read `book_uid` directly instead of resolving a binding, and
  projection writes durable tables. The mirror stays for remote merge and
  conflicts.
- Import gains a hashing pass. Large PDFs may spend noticeable time there; the
  cost is measured before the design is finalized. A background backfill covers
  existing libraries.
- Durable records are small and are not garbage-collected automatically.
  Reading history grows until the user forgets a book.
- `docs/DATABASE.md`, `docs/SYNC.md`, `CONTEXT.md`, and the unwatch/remove copy
  all change. ADR 0008 no longer holds.
- A file replaced by different bytes at the same path keeps the book identity
  and inherits its state. This protects external metadata edits, but a user who
  swaps a file for a different book can carry annotations across. A manual
  Split action is future work.
- A hash failure or a file that disappears before its first hash needs a
  manual relink; the durable record is kept.

## Risks accepted

- The migration is large and touches every user-state table. The backup and
  fail-closed rule are the mitigation, not a rollback migration.
- Hashing during import adds I/O to every import. If measurement shows a
  material regression on large PDFs, the fallback is background hashing plus
  rename detection and a wait before destructive actions.
- A 30-day Forget restore can race with new reading on the fresh identity. The
  conflict dialog is deliberate; the alternative is a silent merge that can
  duplicate annotations.
- Durable state for books with no file is invisible unless the user opens
  Reading history. The view is part of this work, not a later addition.

## References

- `sidecar/src/commands/library.rs` for the unwatch purge.
- `sidecar/src/repository/books.rs` for the delete cascade.
- `sidecar/src/sync/` for identity, capture, merge, and the mirror.
- `docs/DATABASE.md`, `docs/SYNC.md`, `docs/TESTING.md`.
- ADR 0008, ADR 0013.
- Issues #280 and #281 for the provider contract.
