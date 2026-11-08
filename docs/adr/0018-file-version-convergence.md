# ADR 0018: File-version convergence for book files

Status: accepted
Date: 2026-11-08
Decides: a per-book `file_version` pointer minted only by the re-import path, a
content-addressed `blobs/books/` staging channel, adoption onto the existing
book identity, staging-folder GC, and a sync-folder watcher with open-book
deferral
Supersedes: the "syncing book files themselves is out of scope" sentence of
ADR 0013 D2, and the "Sync never moves, copies, or deletes a book file" rule in
`docs/SYNC.md`, in the single case of adoption
Relates to: ADR 0013 (cloud-folder sync), ADR 0014 (durable books), ADR 0015
(sync recovery), ADR 0017 (pre-decided winners), `CONTEXT.md` (Book file, Book
identity), `docs/SYNC.md`, `docs/SYNC_ISSUES.md`, `docs/DATABASE.md`

## Context

User-authored state travels between machines; book files do not. Operations are
capped at 1 MiB (`MAX_OP_FILE_BYTES` in `sidecar/src/sync/model.rs`) and carry
field maps for user state, not bytes. The only blob grammar in the sync folder
is cover-specific (`cover_file_name` in `sidecar/src/sync/store/covers.rs`: 8 to 64
hex digits plus an image extension, 16 MiB cap). A user edits a book's file
outside TuxBooks, in Calibre or Sigil or by downloading a new edition. One
machine changes. Every other machine stays on the old bytes. Annotations and
progress keep working, but their locators now resolve against text that no
device considers current, and nothing tells the other devices that a newer file
exists.

The producing side already exists. The library reconciler reacts to externally
changed watched files: `handle_modified` in
`sidecar/src/services/library_reconciler.rs` gates on a size and mtime
divergence from the stored snapshot, then re-imports through `import_file`
(`sidecar/src/services/book_importer.rs`), which upserts the file row by path
and hands the file to `ensure_book_identity`. The identity machinery already
folds rewritten files onto one book: `ensure_book_identity`
(`sidecar/src/sync/identity.rs`) rehashes when size or mtime diverge from the
stored binding, and `bind_hash` keeps the existing uuid, adding the new hash as
another alias. What is missing is transport for the bytes and a shared pointer
that says which bytes are current.

## Decisions

### D1. A `file_version` pointer, minted only by the re-import path

A book gains a `file_version` in its shared state, keyed by book uid: the
content hash, the byte size, and the HLC of the re-import that produced it. It
merges as one value, entity-level LWW like reading progress. A version is one
coherent hash-and-size pair. Mixing fields from two devices is not a version
either device wrote. The newer HLC wins the pointer.

Only the re-import path mints it: the `handle_modified` → `import_file` chain,
when the upsert updated an existing book and the freshly computed hash differs
from the book's current winning `file_version`. That publish-only-on-hash-change
guard is the loop break. Adoption (D3) replaces local bytes with the winner, so
any re-import event the adoption itself triggers recomputes the winning hash
and mints nothing.

A first import never mints. A new book's file stays local, as ADR 0013 D2
decided for the catalog. A deleted local file never propagates either; local
disappearance is not a shared delete (ADR 0013 D6), and the last published
version stays authoritative for every other device.

### D2. A `blobs/books/` staging channel in the sync folder

Book file bytes travel as content-addressed blobs named
`blobs/books/<64-hex>.<ext>`, a sibling of the existing `blobs/covers/`
channel. The name grammar is validated exactly like covers: only names matching
the grammar cross the sync boundary. The grammar is also the traversal defense.
A name like `../../etc/passwd` never matches, which the existing cover-blob
test already pins (`cover_blob_storage_round_trips_and_rejects_bad_input`).
Publication is atomic: write `<hash>.part`, then rename, the same
temp-then-rename pattern operations and covers use. Consumers trust only
grammar-matching names and verify the SHA-256 on receipt regardless; content
addressing makes verification free.

The cap is 256 MiB. A larger file records a dedicated non-retryable issue kind,
`book_blob_oversize`, that the retry sweep skips like the other human-required
kinds (ADR 0017 D4): only shrinking the file or raising the cap fixes it, and
no schedule can.

The blob is staged before the `file_version` operation is published, but
arrival order still cannot be assumed from an eventually consistent folder. A
consumer therefore adopts only when the blob for the winning hash is present
and hash-verified; until then it retries on the next pass and changes nothing.

### D3. Adoption re-binds onto the existing identity

A device whose book's local file hash differs from the winning `file_version`
fetches the blob, verifies the hash, replaces its local file's bytes, and lets
the existing identity sweep rebind. `ensure_book_identity` rehashes on the size
and mtime divergence, and `bind_hash` resolves to the existing uuid, adding the
new hash as an alias. Adoption never mints a new identity and never runs a
merge. The book every annotation and progress row points at is the same book
before and after.

The settle condition is exactly hash equality: the device's local file hash
equals the winning `file_version`. Nothing else counts as settled. Not "blob
downloaded", not "operation applied". A device whose book folder is itself
cloud-synced usually finds the hashes already equal, because the cloud client
delivered the bytes and the reconciler re-imported them; adoption is then a
no-op, and the staged blob is redundant but harmless.

Concurrent edits from two offline devices publish two versions and two blobs.
The newer HLC wins the pointer. Content addressing destroys nothing. The
loser's bytes stay in the folder under their own hash, retrievable until GC
(D4) removes them as superseded. A crash between the byte replace and the
rebind self-heals. The file sits at the new bytes, the sweep rehashes on the
next pass, and the binding lands on the same uuid.

### D4. Staging GC: winners forever, superseded for 90 days

The blob matching a book's current winning `file_version` is kept forever. It
is the repair channel. A device that lost its file, or was offline past any
window, can always re-fetch the winner. A late device only ever adopts the
winner, never intermediate versions, so pruning superseded blobs never blocks
convergence.

Superseded blobs are pruned after 90 days. Consumers ignore off-grammar
artifacts, including cloud conflict copies from write races, and GC deletes
them only after the same window. Pruning is a pure function of the state DB
(which hashes are current winners) plus the folder's own file mtimes, so any
device can run it in a pass. This is the folder's first GC; the operation
folder's no-GC rule (ADR 0013 D9, ADR 0017 D5) is untouched.

### D5. A sync-folder watcher wakes the engine; open books defer adoption

A notify-based watcher on the sync folder follows the library watcher's pattern
(`sidecar/src/services/library_watcher.rs`: recommended watcher, reconciler
thread, quiet-period debounce of a few seconds). It filters to the op and blob
grammars and wakes the engine. The engine then sees remote versions at provider
latency plus seconds instead of up to the 10 s pass interval (`PASS_INTERVAL`
in `sidecar/src/sync/engine.rs`). The provider remains the latency floor; the
watcher only removes the idle wait.

If the book is open on the receiving device, adoption defers until the book
closes, and the library shows a "newer version available" badge. Swapping bytes
under a running Readium or PDFium session is the crash path, so it never
happens. Closed books adopt silently in the background.

## Invariants

- Re-anchoring is out of scope. A genuinely different edition can shift CFIs;
  the annotation `text` payload preserves meaning regardless. A text-proximity
  re-anchor is a future, evidence-gated decision, not part of this one.
- Progress and annotations keep their stored locators across adoption.
- Book bytes flow only through the blob channel. The 1 MiB operation cap does
  not move; a `file_version` operation is a few hundred bytes.
- Sync never blocks the reader. Adoption failures stay visible as sync issues;
  races stay silent per ADR 0017.

## Consequences

- Every device converges on the same file version, and the settle condition is
  checkable on each device with one hash.
- Annotations and progress survive adoption with their identity and locators
  intact; nothing is re-keyed.
- The folder holds every distinct version published in the last 90 days plus
  all current winners. The winners alone approach one copy of every book in the
  library: 200 books at a 3 MiB average is about 600 MiB, held indefinitely.
  Each external edit adds a transient copy of the edited book for 90 days.
  Large PDFs near the 256 MiB cap dominate the tail. This is an accepted cost.
- A new sync issue kind, `book_blob_oversize`, joins the human-required set.
- The engine loop gains a second wake source: the sync-folder watcher calls the
  existing wake alongside local dirty writes.
- The `file_version` row joins the "What syncs" table in `docs/SYNC.md`, and
  its "Sync never moves, copies, or deletes a book file" sentence narrows to
  exclude adoption, when the companion tasks land.
- Companion tasks track the implementation: blob staging and publish, adoption
  with open-book deferral, staging GC, the sync-folder watcher, and a
  re-anchoring backlog item. They wait for ADR 0017's companion tasks (write
  time clock minting, automatic retry, review removal) to land before
  branching.

## Risks accepted

- Storage growth in the sync folder is permanent for winners. A library with
  many large PDFs pays the winner cost forever; the 256 MiB cap bounds a single
  blob but not the total.
- Re-anchoring drift. A different edition can leave a highlight pointing at the
  wrong passage while its text payload still shows what the user selected. The
  drift is visible, not silent, and the re-anchor decision stays open.
- A large blob can take a long time to arrive through the cloud client. Devices
  retry and change nothing until the hash verifies, so a slow delivery is a
  delayed convergence, not a wrong one.
- A device that edits externally while another device is mid-adoption produces
  two blobs and a pointer flip to the newer HLC. The mid-adoption device
  re-settles against the new winner on a later pass.

## References

- `docs/SYNC.md` for the protocol, folder layout, and merge table; it gains the
  `blobs/books/` channel, the `file_version` row, and the adoption flow.
- `docs/SYNC_ISSUES.md` for issue kinds; it gains `book_blob_oversize`.
- `docs/DATABASE.md` for the shared-state tables; it gains the `file_version`
  columns and the GC bookkeeping.
- `CONTEXT.md` for Book file and Book identity.
- ADR 0013 for the transport and the identity model this builds on; ADR 0014
  for durable books; ADR 0015 for issue actions; ADR 0017 for pre-decided
  winners and the retry sweep.
- `sidecar/src/sync/store/covers.rs` (`cover_file_name`, `store_cover_blob`),
  `sidecar/src/sync/store/io.rs` (`write_bytes_atomic`),
  `sidecar/src/sync/model.rs` (`MAX_OP_FILE_BYTES`),
  `sidecar/src/services/library_reconciler.rs` (`handle_modified`),
  `sidecar/src/services/book_importer.rs` (`import_file`, `finalize_import`),
  `sidecar/src/repository/books.rs` (`upsert_file`),
  `sidecar/src/sync/identity.rs` (`ensure_book_identity`, `bind_hash`),
  `sidecar/src/services/library_watcher.rs` (notify and debounce pattern), and
  `sidecar/src/sync/engine.rs` (`PASS_INTERVAL`, the pass loop and wake).
