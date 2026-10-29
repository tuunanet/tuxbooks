# ADR 0013: Cloud-folder sync of user state

Status: accepted
Date: 2026-10-28
Decides: transport and scope for synchronizing TuxBooks state between machines
Contracts this builds on: `docs/SYNC.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`
Supersedes: the "no cloud sync" sentence in the architecture overview

## Context

TuxBooks is local-first. It has no backend server, no account, and no network
dependency. The catalog is SQLite, keyed by absolute book paths with local
auto-increment row ids. Reading progress, annotations, collections, metadata
overrides, and `last_opened_at` are user-authored state on top of that
path-keyed catalog.

Users read the same library on more than one machine. The book files may
already live in Google Drive, Dropbox, or another synced folder. The missing
piece is the user-authored state.

A synced folder is not a database. Cloud clients are eventually consistent,
have no cross-machine lock, deliver files late and out of order, and create
conflict copies. A design that writes a SQLite file or a single mutable JSON
state file into that folder will lose data. The design has to treat the folder
as untrusted transport and make every write immutable and idempotent.

## Decisions

### D1. Transport is a user-selected folder, not provider APIs

TuxBooks writes into a folder the user picks. The cloud client does the upload
and download. This is one code path for every provider, needs no OAuth app or
token storage, and keeps the no-network property. The cost is that the app
inherits the client's latency, conflict copies, and lack of locking; D3 to D6
are built around that cost.

Ubuntu One file storage is not a candidate because Canonical shut it down in 2014. Any folder-syncing client works.

### D2. Only user-authored state syncs; the catalog stays local

The shared set is reading progress, annotations, metadata overrides, collection
definitions and membership, `last_opened_at`, and cover overrides with their
blobs. Book rows, paths, watched locations, source metadata, the cover cache,
search indexes, and reader appearance stay local and derived.

A machine that has never imported a book can hold its shared state and apply it
when the content appears. Syncing book files themselves is out of scope; the
cloud client already does that better.

### D3. Book identity is a uuid linked to content-hash aliases

Paths and row ids are machine-specific. A random 128-bit uuid is the shared
identity. The SHA-256 of the file bytes is a discovery key. A metadata embed
rewrites the file, so the uuid stays and the new hash becomes another alias.
Two machines that imported the same bytes independently publish different uuids
for the same hash; every device deterministically picks the smallest uuid and
re-keys the loser. This makes bootstrap convergent without a coordination
server.

The hash is never the identity, because a rewrite would otherwise create a new
book. Fuzzy bibliographic matching is rejected: merging two different editions
silently is worse than leaving them separate.

### D4. The folder holds immutable per-device operation streams

Each device writes `ops/<device>/<clock>-<op id>.json`, temp-then-rename. Files
are never modified. Readers dedupe by operation id, so a cloud conflict copy is
a duplicate rather than corruption. A partial file fails JSON validation and is
retried. The library is bound to one random library id in `library.json`; a
mismatch requires explicit confirmation.

### D5. Merge is field-level LWW, except where the record is one value

Annotations, metadata overrides, and collections merge per field. Reading
progress, membership, and last-opened merge as whole records, because a locator
assembled from two machines is not a position either machine wrote. Hybrid
logical clocks give a total order; the device id breaks ties. Losing values go
to `sync_conflicts`, so no user text disappears silently.

### D6. Deletes win; local disappearance does not delete shared state

Deleting an annotation or collection writes a tombstone with the prior state.
A concurrent edit does not resurrect it; the edit is kept as a conflict. A
30-day trash entry allows an explicit restore from any machine.

Unwatching a folder, losing a file, or deleting a local book row is a local
disappearance. It never emits a shared delete. The shared state waits and is
projected again when the same content is re-imported.

### D7. Local changes are captured at write time

Triggers write a canonical snapshot into `sync_dirty` when the row changes.
The capture pass uses that snapshot, not the current row, so a remote projection
between the edit and the sync pass cannot erase the edit. Cascades caused by a
vanished parent are skipped by the same triggers. Projection writes local rows
and is idempotent; the echo markers clear on the next pass.

### D8. The folder is plaintext but untrusted

Operation payloads are schema-versioned JSON. Every field is type- and
size-checked; unknown kinds, unsafe uids, path-like cover names, oversized
operations, and symlinks are rejected. The folder is readable by the cloud
provider. App-level encryption is deferred because a forgotten passphrase would
make the shared state unrecoverable, and adding it later needs a key-management
decision rather than a bolt-on.

### D9. No destructive compaction in v1

The operation log is the backup. Operations are small and progress is coalesced
by the dirty-marker upsert. Keeping every operation makes replay deterministic
and avoids snapshot watermarking under eventual consistency, which is unsound
unless a snapshot enumerates every covered operation. A derived, non-authoritative
snapshot can be added for inspection later.

## Consequences

- A new background subsystem in the Rust sidecar, `sidecar/src/sync/`, with a
  few seconds of hashing per pass and no network code.
- New tables in the catalog database: identity bindings and aliases, dirty
  markers, materialized state, operations, applied ids, remote-file bookkeeping,
  issues, conflicts, and trash.
- New triggers on the user-state tables. They are inactive work when sync is
  off, but they are always installed.
- New JSON-RPC methods and a Settings > Sync tab.
- A book file is hashed lazily, not at import, so import performance is
  unchanged. A book's shared state may wait a few passes for its hash.
- A metadata embed sets a rehash marker before it rewrites the file and clears
  it after the snapshot update, so a crash cannot strand the identity. Duplicate
  local files for one uuid project onto the lowest book id and surface a Sync
  issue; deleting that row moves the state to the next copy.
- Two machines with very different wall clocks can produce surprising LWW
  winners until the clocks converge. The losing value is kept.
- Two independently created annotations on the same passage can duplicate.
  Fuzzy dedupe is rejected to avoid deleting a real annotation.
- The catalog stays path-keyed. Sync never becomes a second source of truth for
  paths or book rows.

## Risks accepted

- A cloud client can leave a `.json` file partially synced for a while. The
  reader retries and reports an issue; it never applies a partial operation.
- A user can edit the folder by hand. Every payload is validated, but a valid
  operation from a hand-edited file is indistinguishable from a real one. The
  folder is trusted as user input, not as a security boundary.
- Hashing a very large PDF can take longer than one pass. The pass waits in a
  blocking task, but the ui and reader are not blocked; the next pass continues.
- A folder that disappears is reported and retried. The app does not recreate
  a missing mount, because doing so could create an empty `library.json` that
  later conflicts with the real one.

## References

- `docs/SYNC.md` for the wire format, folder layout, merge table, and test
  inventory.
- `docs/DATABASE.md` for the new tables.
- `docs/ARCHITECTURE.md` for the sidecar module contract.
