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
`sidecar/tests/cloud_sync.rs`. The decision records are
[ADR 0013](adr/0013-cloud-folder-sync.md) for the transport and
[ADR 0015](adr/0015-sync-recovery.md) for recovery and issue actions.

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
| Forget and restore (whole book)                     | book uid                  | delete wins, explicit restore       |
| Book file version (content hash + size)             | book uid                  | entity-level LWW                    |

Cover overrides travel as content-addressed blobs under `blobs/covers/`; a
book file's bytes travel the same way on a published external edit (ADR 0018):
`blobs/books/<64-hex>.<epub or pdf>`, capped at 256 MiB and staged before the
`file_version` op.
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

## Choosing a sync folder

A folder without a TuxBooks library is adopted directly. TuxBooks creates
`TuxBooks/library.json`, binds this device to it, and re-baselines the local
durable state. This covers the normal first connection and the normal
"detach, then choose a new folder" path. It does not show a mismatch prompt.

A folder that already contains `TuxBooks/library.json` with a different
library id belongs to an existing library. Settings offers two explicit
choices:

- **Use this library** merges this device's durable state into it. The local
  sync mirror, aliases, and operation bookkeeping are reset and re-baselined;
  local books, files, progress, annotations, and metadata stay.
- **Start a new library here** moves the existing `TuxBooks` directory to a
  sibling `TuxBooks.before-<timestamp>` and creates a fresh library at the
  chosen path. Nothing is deleted. Other devices using the old folder must
  reconnect to the archived path.

Detaching a device does not delete `TuxBooks/library.json`. Reconnecting to the
same folder is a normal reconnect. A copied sync folder is a different library
only when its `library.json` id differs.

## Book files and backups

Sync never moves, copies, or deletes a book file. The one exception is
adoption (ADR 0018 D3): a device whose copy is behind the book's winning
`file_version` overwrites its local file's bytes with the verified staged
copy, and nothing else — a vanished local file is never resurrected, and no
sync path deletes a book file. A metadata embed is a file
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
  is deterministic, so replay order cannot produce different winners. An
  identity merge is silent: the losing state moves to the winner, the merge is
  kept in `sync_book_merges` for diagnostics, and no Settings entry asks the
  user to interpret a uuid.

Hashing is lazy and bounded: the sweep hashes books that have no binding or
whose size/mtime changed, for a few seconds per pass. Imports never wait for a
hash. A book whose file is unavailable keeps its binding and state. A failed
background hash retries automatically with bounded backoff (1 minute, 5
minutes, 15 minutes, 1 hour, 6 hours, then 24 hours as the cap), and a snapshot
change or relink returns it to pending. With sync on, the failure opens one
`hash_failed` Sync issue per book (not per location) with **Retry indexing**;
with sync off, the book itself shows the warning and the same action. The book
is failed when any of its locations failed.

## Folder layout

The user picks a folder. TuxBooks uses a `TuxBooks` child unless the picked
folder is already a TuxBooks sync folder:

```
<chosen folder>/TuxBooks/
  library.json                 # schema, random library id, created_at
  devices/<device id>/device.json
  ops/<device id>/<wall>-<counter>-<op id>.json
  blobs/covers/<cache name>
  blobs/books/<64-hex>.<epub or pdf>
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

A whole-book Forget is one `kind: "book"` operation with `entity_uid` and
`book_uid` both set to the forgotten uuid. Its `prior` map carries
`snapshot` (the portable book snapshot as a JSON string) and
`replacement_book_uid` (the fresh identity when the sender still had a file).
The snapshot names collection memberships by collection uid, never by a local
row id, and leaves provider links out because those stay local. A restore is
the same kind with `restore: true` and the snapshot in `fields`; a Keep or
Merge resolution sends `discarded: true` instead, closing the remote trash
entry without recreating the old identity.

Clocks are hybrid logical clocks. Ordering is `(wall, counter, device id)`.
`next_hlc` is a single SQLite upsert, so concurrent callers cannot receive the
same value. Receiving a remote clock moves the local clock forward. A clock is
minted when the local write happens, inside its write transaction (ADR 0017
D3): an edit made offline carries its own time, so publishing it later cannot
outrank a write that happened after it. A device with a badly skewed wall
clock can win conflicts until real time catches up;
this is documented LWW behavior, not silent data loss, because the losing value
is kept.

Each operation file is capped at 1 MiB; cover blobs at 16 MiB; book blobs at 256 MiB.

A book file version has one minter: the re-import path (`handle_modified` →
`import_file`) on an upsert that updated an existing book, and only when the
fresh hash differs from the winning pointer (ADR 0018 D1) — the loop break
that keeps adoption re-imports silent. A first import never mints, and a
locally deleted file never propagates; the winner stays authoritative. The
op carries hash and size under the minting entity clock.

The consumer half is adoption (ADR 0018 D3): after each successful pass, every
available copy whose binding hash differs from its book's winning pointer
fetches `blobs/books/<winning hash>.<ext>`, verifies the size and SHA-256
against the pointer, and replaces its local file's bytes atomically. A copy
whose bytes already match the pointer is settled; a copy whose bytes moved
without a rebind (an external edit in flight) is skipped, because overwriting
it would race the user's own write. The swap refreshes the file snapshot, so
the identity sweep rehashes once and rebinds onto the existing book uid —
annotations, progress, and locators are untouched. Adoption never publishes a
pointer: the re-import its own swap can trigger sees the winning hash and
mints nothing. A missing blob is op-before-blob arrival and waits silently; a
blob that fails verification records a `book_file_adopt_failed` issue and is
retried on the next pass.

Open-book deferral (ADR 0018 D5) is not implemented yet: the sidecar has no
open-book registry, so there is no discoverable set of books to defer. Today
every settled-copy check runs in the engine pass, and the library surfaces the
not-yet-settled state as a per-book `newerVersionAvailable` flag on
`list_books` (a small badge on the card and list rows). The registry, the
swap-on-close, and deferring adoption while a reader session holds the file
are a follow-up; until then a book left open during another device's edit can
have its bytes swapped underneath the open reader.

## Merge rules

- **Field-level** (annotations, metadata overrides, collections): each field has
  its own clock. Editing a note on one machine and a highlight colour on another
  merges both.
- **Entity-level** (progress, membership, last opened): the record is one
  coherent value. Reading progress is a locator, and mixing fields from two
  devices would create a position neither device had. Membership add/remove is
  also one value, so a later add can undo an earlier remove.
- **Delete wins** for annotations and collections. A tombstone is permanent. A
  concurrent edit that loses is kept in `sync_conflicts` as an invisible
  diagnostic; it does not resurrect the entity. The explicit trash restore is
  the only way back.
- **Absent books** do not delete state. Unwatching a folder, a missing file, or
  deleting a local book row never emits a shared delete. State waits under its
  book uuid and is projected when the same content is imported again.
- **Forget is the explicit shared delete.** A `book` tombstone wins over
  in-flight edits for the old uuid. Receivers rebind any local file rows to the
  sender's fresh identity, remove the old aliases, and keep the snapshot in
  their own Reading history trash. A forgotten uuid is not an identity-merge
  candidate, so a stale alias or an old `sync_book_merges` edge cannot bring it
  back. Restore is an explicit `book` operation; Keep and Merge close the
  remote trash entry with a discard.
- **Metadata lists** travel only when the user customized them. A machine with a
  different copy of the book does not fight over source-derived authors or
  subjects.

Losing field values are written to `sync_conflicts` as invisible diagnostics
(ADR 0017 D2). The winner is applied immediately and nothing asks the user to
choose; the losing value is kept for support, not for review. Conflict
diagnostics are described under [Conflict diagnostics](#conflict-diagnostics).

## Conflict diagnostics

A discarded value stays in `sync_conflicts` until the 30-day window expires.
The merge result does not wait: the winner is applied immediately and stays
applied, and no surface asks the user to settle anything. The decision is
recorded in [ADR 0017](adr/0017-conflict-free-sync-pre-decided-winners.md).

Each row carries the kind, entity uid, field, both JSON values, both hybrid
clocks with the writing device, and the time the race was recorded. The rows
have no interactive surface: nothing lists them in Settings > Sync, the live
status payload carries no conflict count, and a new race never opens an issue.
Support reads them through Copy diagnostics, which reports the row count and a
sample of open rows without their values.

Rows recorded before races went silent (ADR 0017 D1) may still have a paired
`sync_issues` row of kind `conflict`. Those legacy issues are excluded from the
issue list and the status count and can never be dismissed; the maintenance
sweep is the only thing that closes them. A status refresh first reconciles
each open row against the mirror. A row closes once a newer write has moved
the value or clock past its winner. The refresh then deletes rows older than
30 days, closing each row's issue once no open row shares its key. Progress
races are diagnostic only and never open an issue.

## Local capture and projection

Triggers on `annotations`, `reading_progress`, `book_metadata_overrides`,
`book_authors`, `book_subjects`, `collections`, `book_collections`,
`book_records.last_opened_at`, and `book_trash` write a canonical snapshot into
`sync_dirty` at the moment of the change. Progress, metadata, last-opened, and
book lifecycle key directly on the durable book uid; annotations carry
`book_uid` beside the public book id; membership keys on collection uid + book
uid. No capture path looks up a per-file sync binding. The capture pass uses
that snapshot, not the current row, so a remote projection that lands between
the edit and the sync pass cannot erase the edit. Capture no longer waits for a
content hash before publishing: the durable uuid is authoritative, and if two
devices chose different uuids for the same bytes the identity aliases converge
and merge them later.

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

Forget a book is the same 30-day idea at the whole-book level. The local
`book_trash` row is written atomically with the local delete; a trigger turns it
into a `book` operation. Receivers apply the book tombstone, keep their own
copy of the snapshot in Reading history, and can restore it locally even if
they never imported the file. A restore sends the snapshot back, recreates the
old durable record and state, and moves file rows from the fresh identity to
the old one. Keep and Merge stay local choices and send a discard so the other
machines close their copy of the trash entry; Merge's state travels as ordinary
entity operations on the fresh identity. Provider links are deliberately not
part of the shared snapshot: a local restore keeps them on the machine that
made the original Forget, and a restore elsewhere recreates the book without a
provider link. The operation log still holds the tombstone and prior state
after 30 days.

## Waiting books

A sync folder can carry state for a book this machine does not have. The
mirror keeps it so the annotations and progress can appear when the same bytes
are imported. Settings > Sync lists those books under **Waiting for books**,
with whatever metadata the folder carries, the progress percentage, the
annotation count, and a sample annotation when no metadata is available.

Settings shows the first five and a **View all** dialog with search by title or
book uid. **Locate file** opens a file picker and attaches the book to the
chosen file. **Forget on this device** hides one waiting book here and removes
it from the count; **Forget all on this device** hides every waiting book. The
shared copies stay in the folder, so importing the exact bytes can still attach
the state later, and other devices are not affected. There is no shared-delete
action for a waiting book; starting a new library is the way to leave the old
library's waiting state behind, and the app archives the old library instead of
deleting it.

Locate file is a shortcut for "these are the bytes", not a new merge rule. The
sidecar hashes the picked file and looks up the content-hash aliases. The alias
must already exist and must resolve to the waiting uid. If the alias is missing
or names a different book, the command refuses with an error that the bytes
differ, adds nothing to the library, and leaves the row waiting. A different
edition therefore never inherits another book's annotations or progress. On a
match the sidecar creates the durable record for the waiting uid when this
machine never had one, attaches the file to that identity, and projects the
mirror state: progress, annotations, metadata overrides, collection membership,
and last-opened. The book leaves the waiting list and appears in the library.

Ignored waiting books never appear in the list, so their row has no Locate file
action. The command also rejects an ignored uid if it is reached; importing the
exact bytes through the normal import path still binds them after a local hide.
A path that is not a readable book, a file already in the library, a hash read
failure, or a byte mismatch leaves the waiting row in place. When the attempt
created a durable record for the uid, a rejected file removes that record
again, so a failed attach adds nothing to Reading history.

## Security and privacy

The folder is untrusted input:

- operation files are size-capped, schema-versioned, and type-checked per field;
- unknown kinds, unknown fields, bad clocks, unsafe uids, and path-like strings
  are rejected;
- cover and book blob names must be content-addressed; no path crosses the
  sync boundary;
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
- an unresolved conflict is kept for 30 days, then expires unread;
- an operation is at most 1 MiB; a cover blob is at most 16 MiB;
- a book blob is at most 256 MiB; a larger book records a `book_blob_oversize`
  issue and publishes nothing until the file shrinks or the cap is raised;
- a forgotten-book snapshot is capped at 512 KiB inside the operation. A larger
  snapshot still sends the delete (so every machine forgets) and records an
  issue instead of pretending the restore exists;
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
- a waiting book hidden locally and still attachable later, and Locate file
  attaching the exact bytes with progress, annotations, metadata, last-opened,
  and collection membership while a mismatch, an ignored book, a bad path, a
  parse failure, and a projection failure each leave no phantom book and
  repair against the attached file;
- duplicate and corrupt operation files;
- delete, trash, and restore;
- metadata title, authors, subjects, and a cover blob;
- a rewritten file keeping its identity across two machines;
- library mismatch confirmation;
- same-name collection merge;
- concurrent note edits converging with the loser kept;
- conflict diagnostics: a race recording both values, devices, and clocks;
  no diagnostic row reaching the issue list or the status payload; legacy
  rows and their paired issues expiring after 30 days;
- duplicate copies sharing one uuid, the duplicate issue, and state moving to
  the remaining copy when the canonical row is deleted;
- issue actions and targets, retry for projection, identity, reprojection,
  lifecycle, and a failed pass, auto-resolution when the condition clears,
  dismissal refused for actionable rows, and conflicts excluded from the issue
  list and count;
- a pending rehash surviving a missed snapshot update, as in a crash between
  the rewrite and the snapshot write;
- file-version adoption: a closed book adopting the winning bytes and
  rebinding onto its existing identity with annotations and progress intact,
  a pointer waiting silently for its blob and converging once it arrives, a
  corrupted blob blocking adoption behind a visible issue until it verifies,
  an adoption re-import minting nothing, an in-flight external edit left
  alone until it wins the pointer, and a vanished file changing nothing.

The frontend tests cover the Settings tab, mismatch confirmation, issue and
trash actions, the primary action per issue kind, Copy details, opening the sync
folder without a renderer path, Locate file for a waiting book and its
cancel/mismatch paths, the sidebar attention dot, the toast
transition and dismissal, the always-mounted live region, the reader hide, the
stale status-read race, unsubscribing on unmount, and the IPC policy for the
sync folder.

## Out of scope

- provider APIs, OAuth, and background daemons;
- syncing book files themselves;
- app-level encryption;
- Windows and macOS packaging (the folder protocol is platform-neutral, but
  only Linux is packaged today);
- multi-library support in one app profile.
