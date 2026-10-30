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
| Forget and restore (whole book)                     | book uid                  | delete wins, explicit restore       |

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

Losing field values are written to `sync_conflicts` and surfaced in
Settings > Sync's [Conflict review](#conflict-review), with the kept and
discarded values. The current state always has a winner, but the loser stays
inspectable until the conflict is resolved. Settling a conflict is described
under [Conflict review](#conflict-review).

## Conflict review

A discarded value stays in `sync_conflicts` until the user resolves it or the
30-day window expires. The merge result does not wait for that decision: the
winner is applied immediately and stays applied.

Each open row carries the kind, entity uid, field, both JSON values, both
hybrid clocks with the writing device, and the time the conflict was recorded.
The `sync_conflicts` sidecar command returns open rows newest first with the
book title and author, the field, both values, and the device names. Settings >
Sync lists them under Conflicts to review, grouped by book with delete and edit
rows first, then whole-entity rows, then single fields. Each row shows the kept
and the discarded value, both devices, and both times. A special field name is
labelled: `__entity__` is a whole-entity record, `__deleted__` is an edit that
lost to a delete, and `__restore__` is a restore that lost to a newer delete.
Several losing writes for one field share one issue; the issue closes only when
the last conflict with that key is resolved.

Two resolutions are offered:

- **Keep winner** stamps `resolved_at`. The applied state does not change.
- **Apply loser** republishes the discarded value as an ordinary operation with
  a fresh hybrid clock, so every device replays it and converges. A field
  conflict writes one field, a whole-entity conflict writes the whole record,
  and a delete/edit or lost-restore conflict writes the explicit restore
  operation. Resolution never deletes the losing value from the row, and a
  restore also closes the local Recently deleted entry on every device.

Settings > Sync offers Keep this device and Keep other when one side of the
conflict is this device. Those labels choose between the applied winner and the
discarded value, whichever device wrote each one. When neither side is this
device, the buttons read Keep winner and Apply other. When replaying the loser
is unsafe, that choice is disabled and the reason is shown. Decide later sets
the row aside for this session without closing it. A bulk Keep current winner
closes the rows shown with the applied value. The winner stays applied until you
choose. When the backend reports more open rows than it loaded, the section says
"Showing first N of M" and the bulk action covers only the loaded rows.

The queue is reconciled against the mirror on every status refresh and before
a list. A row closes once its winner no longer matches the current value and
clock, so a device that replays another device's resolution stops showing a
stale choice and its issue closes with it. Book identity merges are
deterministic and can only be kept; replaying the losing uuid would resurrect
an identity every device already collapsed.

Progress never prompts. Progress conflicts are kept in the table for
diagnostics, but they are left out of the review list and the status count, and
they never open an issue.

Unresolved conflicts older than 30 days are removed on the next status refresh
or list, and their issue closes when nothing else shares the key. The status
count only includes open, unexpired rows. The folder is not required to read
the queue: when sync is off or the folder is unavailable, device names fall
back to the stored device ids.

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
book uid. **Forget on this device** hides one waiting book here and removes it
from the count; **Forget all on this device** hides every waiting book. The
shared copies stay in the folder, so importing the exact bytes can still attach
the state later, and other devices are not affected. There is no shared-delete
action for a waiting book; starting a new library is the way to leave the old
library's waiting state behind, and the app archives the old library instead of
deleting it.

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
- a queued reprojection that failed;
- a forgotten-book snapshot that could not be published or read back, so
  another machine can apply the delete but cannot offer a restore;
- a shared restore that had to replace newer local state on the fresh identity.

The Settings > Sync tab shows the state (`Off`, `Up to date`, `Syncing`, `Needs
attention`), last sync, pending local items, books waiting for their file,
issues, conflicts, and recently deleted items. Invalid operation files are
retried five times before being marked processed with an issue, so one bad file
cannot starve the rest.

The sidebar's Settings entry shows a small dot when sync is on and the engine
reports an error, an open issue, or a conflict to review. The dot is visible
wherever the sidebar is, including while Settings is open. It follows the same
rule as Settings > Sync: with sync off, leftover counts stay hidden because the
Settings lists are hidden too. A toast appears once when the state changes into
attention, not on the first load and not on every status update. It sits
bottom-center, is hidden in the reader, and does not sit over the import status
or block reading or library interaction. Resolving the condition clears both; a
dismissed toast stays hidden until attention clears and later returns. The toast
does not auto-dismiss.

### Sync issues and actions

Each row carries a kind, a short target label, and one action the sidecar
computes from the kind. The renderer never parses an issue key.

| Kinds                                                                                                                                                                            | Action       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `projection_failed`, `identity_failed`, `reprojection_failed`, `book_lifecycle_failed`, `sync_failed`, `operation_retrying`, `cover_missing`, `cover_blob_failed`, `hash_failed` | Retry        |
| `operation_rejected`                                                                                                                                                             | Open folder  |
| `duplicate_book`, `book_snapshot_missing`, `book_snapshot_invalid`                                                                                                               | Copy details |
| `invalid_dirty_kind`                                                                                                                                                             | Dismiss      |

Retry does the work the kind needs, not just another background wake-up:

- a projection or reprojection failure projects the shared state for that book;
- an identity failure hashes and binds the book, then projects it;
- a lifecycle failure replays the mirror's Forget, restore, or discard;
- a failed pass runs one pass now;
- an operation retrying has its failure cache cleared so the next pass reads
  the file again;
- a missing cover is applied to its book from the sync folder when the blob has
  arrived;
- a cover publish failure is tried again from the local cover cache;
- a failed hash runs the index pass for every available location of that book,
  starting from a clean backoff. Indexing is local work, so it does not need
  the folder connected.

Open folder is for a rejected operation: the file passed the retry limit, so it
has to be fixed or removed in the sync folder. The renderer passes no path;
the main process opens the folder the sidecar reports.

Dismiss stays for informational rows only. An actionable row cannot be
dismissed, and Dismiss all closes only the informational rows; Retry and Open
folder rows stay listed until their condition clears.

### What closes an issue by itself

A status refresh also sweeps open rows and closes the ones whose condition is
gone:

- the last duplicate binding for a book disappears;
- an operation's current cache row says it applied cleanly (processed with no
  failures), or the file no longer exists in the folder;
- the missing cover is applied to the book, not merely present in the folder;
- a later identity pass binds and projects the book, or the reprojection
  queue succeeds; an open projection issue makes the next pass project even
  when the binding did not change;
- the book behind a projection, identity, reprojection, or lifecycle row is
  gone;
- a hash succeeds, whether the automatic backoff picked it up or Retry ran it;
- a retry closes its own row when the work shows the condition is gone;
- a successful pass closes the `sync_failed` row.

Conflicts are never in this list. They are counted and shown by
[Conflict review](#conflict-review), which owns them until the user settles
them. They are excluded from the Sync issues list and from its status count, so
a Dismiss button can never hide a conflict without resolving it.

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
- an unresolved conflict is kept for 30 days, then expires unread;
- an operation is at most 1 MiB; a cover blob is at most 16 MiB;
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
- duplicate and corrupt operation files;
- delete, trash, and restore;
- metadata title, authors, subjects, and a cover blob;
- a rewritten file keeping its identity across two machines;
- library mismatch confirmation;
- same-name collection merge;
- concurrent note edits converging with the loser kept;
- conflict review: listing values, devices and clocks, keep winner, applying
  the loser for a field and a whole entity, delete/edit and lost-restore
  recovery with trash closing on both devices, settlement after another
  device resolves, one shared issue across two losers, 30-day expiry, and the
  device-id fallback;
- duplicate copies sharing one uuid, the duplicate issue, and state moving to
  the remaining copy when the canonical row is deleted;
- issue actions and targets, retry for projection, identity, reprojection,
  lifecycle, and a failed pass, auto-resolution when the condition clears,
  dismissal refused for actionable rows, and conflicts excluded from the issue
  list and count;
- a pending rehash surviving a missed snapshot update, as in a crash between
  the rewrite and the snapshot write.

The frontend tests cover the Settings tab, mismatch confirmation, issue and
trash actions, the primary action per issue kind, Copy details, opening the sync
folder without a renderer path, conflict grouping and device-relative choices,
the bulk keep, the session set-aside, the sidebar attention dot, the toast
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
