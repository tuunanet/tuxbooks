# Cloud-folder sync

TuxBooks can synchronize user-authored state between machines through a folder
that a cloud client already keeps in sync. Google Drive and Dropbox are the
first targets; the app never calls either API. Any client that materializes a
local folder works, including Nextcloud and Syncthing. Ubuntu One file storage
is not an option because Canonical shut it down in 2014.

The design assumes the folder is untrusted, eventually consistent, and
lock-free. Files can arrive late, out of order, duplicated as cloud conflict
copies, or partially. Nothing in the folder is ever overwritten in place.

Status: implemented in `sidecar/src/sync/` and covered by
`sidecar/tests/cloud_sync.rs`. The decision record is
[ADR 0013](adr/0013-cloud-folder-sync.md).

## What syncs

| Shared state                                        | Key                       | Merge                               |
| --------------------------------------------------- | ------------------------- | ----------------------------------- |
| Annotations (bookmarks, highlights, notes)          | annotation uid            | field-level LWW                     |
| Reading progress                                    | book uid                  | entity-level LWW                    |
| Metadata overrides (scalars, lists, cover override) | book uid                  | field-level LWW                     |
| Collections                                         | collection uid            | field-level LWW, names merge        |
| Collection membership                               | collection uid + book uid | entity-level LWW                    |
| Last opened at                                      | book uid                  | entity-level LWW                    |
| Book identity aliases                               | content hash              | canonical uuid is the smallest seen |

Cover overrides travel as content-addressed blobs under `blobs/covers/`.
Everything else in the app data directory stays local:

- book rows, absolute paths, and watched locations;
- source metadata read from the book file;
- the cover cache itself (it is rebuilt from blobs and imports);
- search indexes and the FTS table;
- reader appearance, theme, and window state;
- the sync folder path and device identity.

The catalog remains derived from the files each machine can see. A machine that
has never imported a book can still hold that book's shared state; it applies
the state when the content appears.

A watched folder may itself be a mounted drive or a folder the cloud client
syncs. The client then copies the book files and TuxBooks syncs reading state
separately. Each machine adds the folder once, because watched locations and
absolute paths stay local.

## Book files and backups

Sync never moves, copies, or deletes a book file. A metadata embed is a file
write: it changes the EPUB or PDF and leaves a one-time `<file>.bak` beside it
(`book.epub.bak`, `book.pdf.bak`). If the book folder is cloud-synced, the
client carries both files, and the other machine reimports the new bytes on its
next watch pass. If the book folder is not cloud-synced, an embedded metadata
edit stays on the machine that wrote it; only library-side overrides, the
values the format cannot store, travel through the state folder.

The scanner, watcher, and identity sweep ignore `.bak` files and the hidden
`*.tuxbooks-*.tmp` files. TuxBooks never deletes or overwrites an existing
backup. A backup deleted in a cloud-synced folder is deleted everywhere that
client syncs it, and TuxBooks cannot recreate the original afterward. The next
embed makes a fresh backup of the file as it exists at that moment, not of the
file's first version.

## Book identity

Row ids and absolute paths are machine-specific. A book's shared identity is a
random 128-bit uuid. The SHA-256 of the file bytes is a discovery key, stored as
an alias:

- on import, the identity sweep hashes the file and looks up the alias;
- if the alias exists, the book binds to its uuid;
- if not, a uuid is created and an identity operation publishes the alias;
- when a metadata embed rewrites the file, the embed path refreshes the stored
  size/mtime snapshot so the next identity sweep rehashes it; the uuid stays
  and the new hash is added as another alias. The old alias is never removed,
  so a machine that has not received the rewritten file yet still resolves to
  the same book;
- the embed sets `books.rehash_pending` before the bytes change and clears it
  after the snapshot update. If the process dies in between, the sweep sees the
  marker and rehashes anyway;
- if two local files map to the same uuid, both are locations on one durable
  book. Sync issues names the duplicate copy. Deleting one file row only ends
  that location; the book uuid keeps its state;
- if two machines independently imported the same bytes before meeting, both
  publish an alias for the same hash. Every device resolves the aliases to the
  lexicographically smallest uuid and re-keys the losing state. The resolution
  is deterministic, so replay order cannot produce different winners.

Hashing is lazy and bounded: the sweep hashes books that have no binding or
whose size/mtime changed, for a few seconds per pass. Imports never wait for a
hash. A book whose file is unavailable keeps its binding and state.

## Folder layout

The user picks a folder. TuxBooks uses a `TuxBooks` child unless the picked
folder is already a TuxBooks sync folder:

```
<chosen folder>/TuxBooks/
  library.json                 # schema, random library id, created_at
  devices/<device id>/device.json
  ops/<device id>/<wall>-<counter>-<op id>.json
  blobs/covers/<cache name>
```

`library.json` binds the folder to one library. Pointing a second, unrelated
library at it returns a mismatch; the UI must confirm before the local sync
state is reset and merged into the folder's library.

Operation files are immutable. Each device writes its own stream temp file then
rename; readers ignore non-`.json` files and dedupe by operation id. A cloud
client's conflict copy (`op (1).json`) is parsed like any other file and
deduped, so duplication is harmless. A partially delivered file fails JSON
validation and is retried.

## Operation format

```json
{
  "schema": 1,
  "op_id": "32 hex",
  "device_id": "32 hex",
  "hlc": { "wall": 1760000000000, "counter": 0, "device": "32 hex" },
  "kind": "annotation",
  "entity_uid": "32 hex",
  "book_uid": "32 hex",
  "deleted": false,
  "restore": false,
  "fields": { "note": "text", "color": null },
  "prior": null,
  "created_at": "2026-10-28T12:00:00.000Z"
}
```

`fields` carries only changed fields. A cleared field is present with JSON
`null`. A delete carries `deleted: true` and the prior canonical state in
`prior`, so any device can offer the 30-day restore. `restore: true` is emitted
only by the explicit restore action.

Clocks are hybrid logical clocks. Ordering is `(wall, counter, device id)`.
`next_hlc` is a single SQLite upsert, so concurrent callers cannot receive the
same value. Receiving a remote clock moves the local clock forward. A device
with a badly skewed wall clock can win conflicts until real time catches up;
this is documented LWW behavior, not silent data loss, because the losing value
is kept.

Each operation file is capped at 1 MiB. Cover blobs are capped at 16 MiB.

## Merge rules

- **Field-level** (annotations, metadata overrides, collections): each field has
  its own clock. Editing a note on one machine and a highlight colour on another
  merges both.
- **Entity-level** (progress, membership, last opened): the record is one
  coherent value. Reading progress is a locator, and mixing fields from two
  devices would create a position neither device had. Membership add/remove is
  also one value, so a later add can undo an earlier remove.
- **Delete wins** for annotations and collections. A tombstone is permanent. A
  concurrent edit that loses is stored in `sync_conflicts` and shown in Sync
  issues; it does not resurrect the entity. The explicit trash restore is the
  only way back.
- **Absent books** do not delete state. Unwatching a folder, a missing file, or
  deleting a local book row never emits a shared delete. State waits under its
  book uuid and is projected when the same content is imported again.
- **Metadata lists** travel only when the user customized them. A machine with a
  different copy of the book does not fight over source-derived authors or
  subjects.

Losing field values are written to `sync_conflicts` and surfaced as a Sync
issue with both the kept and discarded values. The current state always has a
winner, but the loser is inspectable and can be dismissed once read.

## Local capture and projection

Triggers on `annotations`, `reading_progress`, `book_metadata_overrides`,
`book_authors`, `book_subjects`, `collections`, `book_collections`, and
`book_records.last_opened_at` write a canonical snapshot into `sync_dirty` at
the moment of the change. Progress, metadata, and last-opened key directly on
the durable book uid; membership keys on collection uid + book uid;
annotations carry the public book id beside their portable uid and resolve it
to the uid. No capture path looks up a per-file sync binding. The capture pass
uses that snapshot, not the current row, so a remote projection that lands
between the edit and the sync pass cannot erase the edit. Capture waits until
the book's content hash has been bound, so two devices publish the same bytes
under one shared identity.

Triggers check that the parent durable book or collection still exists.
Cascades caused by unwatching or deleting a file row are local disappearances
and are skipped.

Projection writes the merged state back into the local catalog: annotations
and progress upsert by durable book uid (the reader resolves the active file
from it), metadata calls the same recompute path as a local edit (without
rewriting the source file), last-opened updates the durable record, and
memberships insert or delete join rows keyed by book uid. Projection is
idempotent. The local writes fire the same triggers; the next capture pass sees
no field change and clears the echo markers.

## Bootstrap

When sync is first connected:

1. The folder's `library.json` is read or created.
2. The current database is marked for a baseline pass. The pass touches every
   user-state row, which fires the same triggers as an ordinary edit, and marks
   existing memberships and durable `last_opened_at` values.
3. The engine exports the baseline, then reads every remote operation.
4. Remote state for books that are not present is kept in the mirror. When the
   book is imported, the identity sweep binds it and projects that state.

Identical annotations created independently on two machines are not deduped by
content. They have different uids and both survive. Merging them would require a
fuzzy locator match, which risks deleting a real annotation; the design prefers
a duplicate to a loss.

## Deletion, trash, restore

Deleting an annotation or collection emits a tombstone with the prior state.
Receivers delete their local row and record a trash entry. Any machine can
restore the entry for 30 days; restore emits an explicit upsert with
`restore: true` and a newer clock. Restoring a collection also restores its
membership state, which was never discarded.

After 30 days the trash row is no longer offered. The operation log still holds
the tombstone and prior state.

## Errors and status

Sync never crashes the sidecar and never blocks app startup or the reader.
Failures become rows in `sync_issues`:

- a folder that disappeared or became read-only;
- a newer folder schema;
- an invalid or oversized operation;
- a hash failure;
- a missing cover blob (the metadata edit is applied without the cover and the
  issue records it);
- a book that could not be projected;
- a conflict where one side had to be discarded (both values are in the
  detail);
- two local files bound to the same book identity, naming both paths;
- a queued reprojection that failed.

The Settings > Sync tab shows the state (`Off`, `Up to date`, `Syncing`, `Needs
attention`), last sync, pending local items, books waiting for their file,
issues, conflicts, and recently deleted items. Invalid operation files are
retried five times before being marked processed with an issue, so one bad file
cannot starve the rest.

## Security and privacy

The folder is untrusted input:

- operation files are size-capped, schema-versioned, and type-checked per field;
- unknown kinds, unknown fields, bad clocks, unsafe uids, and path-like strings
  are rejected;
- cover names must be content-addressed cache names; no path crosses the sync
  boundary;
- symlinks in the operation tree are skipped;
- no operation causes code execution, a network call, or a source-file rewrite.

Payloads are plaintext, schema-versioned JSON. Google Drive and Dropbox encrypt
at rest and in transit, but the provider can read the files. App-level
encryption is a future decision; a forgotten passphrase would make the shared
state unrecoverable, so it is not bolted on silently.

## Limits and retention

- operations are kept forever in v1; there is no destructive compaction;
- progress is coalesced by the dirty-marker upsert, so a page turn does not
  create one file per event;
- trash is offered for 30 days;
- an operation is at most 1 MiB; a cover blob is at most 16 MiB;
- per pass: 250 dirty entities, 500 remote operations, and a few seconds of
  hashing. Remaining work continues on the next pass.

## Recovery

The operation log is the backup. If a local database is lost, install TuxBooks,
connect the same folder, and import the books. Identity aliases and shared state
reattach by content hash. Local state that never reached the folder is lost with
the database, as with any local-first app; the 2-second dirty poll, the
10-second full pass, and the shutdown flush bound that window.

If the folder itself is lost, every device still has its local catalog and its
own state. A new folder can be started from any device; the others merge into it
through the normal bootstrap.

## Testing

`sidecar/tests/cloud_sync.rs` drives real SQLite databases against one shared
folder. It covers:

- one machine's annotation appearing on another;
- two machines importing the same bytes before meeting, including identity
  merge and both annotations;
- progress replacing the whole locator;
- collections and membership;
- unwatching without a shared delete, then re-import restoring state;
- duplicate and corrupt operation files;
- delete, trash, and restore;
- metadata title, authors, subjects, and a cover blob;
- a rewritten file keeping its identity across two machines;
- library mismatch confirmation;
- same-name collection merge;
- concurrent note edits converging with the loser kept;
- duplicate copies sharing one uuid, the duplicate issue, and state moving to
  the remaining copy when the canonical row is deleted;
- a pending rehash surviving a missed snapshot update, as in a crash between
  the rewrite and the snapshot write.

The frontend tests cover the Settings tab, mismatch confirmation, issue and
trash actions, and the IPC policy for the sync folder.

## Out of scope

- provider APIs, OAuth, and background daemons;
- syncing book files themselves;
- app-level encryption;
- Windows and macOS packaging (the folder protocol is platform-neutral, but
  only Linux is packaged today);
- multi-library support in one app profile.
