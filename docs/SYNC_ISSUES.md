# Sync issues

Every sync problem the renderer shows lives in the `sync_issues` table,
one row per issue key. This is the map: who writes a row, when it closes
on its own, what Retry does, and how the Settings and sidebar surfaces
report it. Conflicts are the exception: races have pre-decided winners
(ADR 0017), so a discarded value lands in `sync_conflicts` as invisible
diagnostics and never enters this flow.

## Flow

1. A failing path calls `sync::identity::record_issue(pool, key, kind,
   detail, file_name)`. The repository upsert (`sync_issues::record`)
   updates an open row with the same key in place, keeping its id; a key
   whose previous row was resolved gets a fresh open row.
2. `SyncService::refresh_status` closes rows whose condition is gone
   (`resolve_cleared_issues` calling `issue_cleared`). It runs after every
   pass and every status read, best effort: a busy database never fails a
   status read.
3. The renderer lists open rows from `status().issues` / `issues()`. When
   `SyncIssueAction::for_kind` maps the kind to `Retry`, the button runs
   `retry_issue(id)`, which takes the pass lock and dispatches through
   `retry_locked`. A successful replay closes the row; a failed one rewrites
   the detail to `retry failed: ...` and keeps it open.

Why Retry exists at all: the first failed attempt marks the operation
applied, so another pass will not re-run it. The replay reads the mirror
(`retry_book_lifecycle`) or the folder file instead of waiting for a pass
to rediscover the work.

## Kinds

Actions come from `SyncIssueAction::for_kind` in `sync/engine.rs`; the
"closes when" column comes from `issue_cleared` in the same file. A kind
without an `issue_cleared` arm never closes on its own.

| kind                                             | recorded by                                                | closes when                                                           | Retry does                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `projection_failed`                              | `merge.rs`, `project_book`                                 | the book row is gone                                                  | reprojects the book's file row                                                             |
| `identity_failed`                                | `merge.rs`, identity sweep                                 | the book row is gone                                                  | hashes the book and reprojects; a vanished book reports gone                               |
| `reprojection_failed`                            | `merge.rs`, `project_book`                                 | the record is gone and no binding remains                             | reprojects, or books the uid gone                                                          |
| `book_lifecycle_failed`                          | `merge.rs`, `project_book_lifecycle`                       | the uid has no `book_records` row                                     | replays `retry_book_lifecycle` from the mirror, then runs a pass                           |
| `sync_failed`                                    | `engine.rs`, `run_pass_locked` (key `sync-pass`)           | a later pass succeeds (`clear_error` resolves the key)                | runs a pass; requires a connected folder                                                   |
| `operation_retrying`                             | `engine.rs`, `record_file_failure` (key `file:...`)        | the folder file is applied or removed                                 | re-reads the file                                                                          |
| `operation_rejected`                             | `engine.rs`, `record_file_failure` after the retry limit   | same as `operation_retrying`                                          | not Retry: the action is "open folder", the file must be fixed                             |
| `hash_failed`                                    | `services/hash_backfill.rs` (key `hash-failed:...`)        | the whole book hashes clean (or the book is gone)                     | resets the hash budget and hashes the book now                                             |
| `cover_missing`                                  | `engine.rs`, `sync_remote`                                 | the cover blob arrived                                                | reapplies the cover                                                                        |
| `cover_blob_failed`                              | `engine.rs`, `sync_remote`                                 | the blob exists in the folder                                         | stores the blob from the folder and reapplies                                              |
| `duplicate_book`                                 | `sync/identity.rs`, `record_duplicate_bindings`            | the book is back to one binding                                       | none; informational                                                                        |
| `invalid_dirty_kind`                             | `capture.rs`                                               | never; action is Dismiss                                              | none                                                                                       |
| `book_snapshot_missing`, `book_snapshot_invalid` | `repository/lifecycle.rs`, `capture.rs`, `merge.rs`        | never; action is CopyDetails                                          | none; the delete applied, no local restore is available                                    |
| `forget_membership_skipped`                      | `repository/lifecycle.rs`                                  | never; action is CopyDetails                                          | none; the snapshot named shelves this library does not have yet                            |
| `restore_conflict`                               | `repository/lifecycle.rs`, `apply_remote_restore`          | never; action is CopyDetails                                          | none; the restore dialog carries the choice                                                |
| `book_blob_oversize`                             | `capture/file_version.rs` (key `book-blob-oversize:<uid>`) | a binding under the cap carries the winning hash, or the book is gone | none; shrinking the file (or raising the cap) and re-importing closes it on the next sweep |
| `book_file_adopt_failed`                         | `engine/adopt.rs` (key `book-file-adopt:<uid>`)            | a later pass adopts the winning version                               | none; adoption retries the blob on every pass and closes the row when it verifies          |

Two invariants worth knowing before changing anything here:

- Recording twice on an open row keeps one row (same id, new detail);
  recording after a resolution opens a second row. The resolved row never
  reopens.
- The kind set is small and closed on the action side: a new kind that
  `for_kind` does not know falls through to CopyDetails, and `retry_locked`
  answers "no retry path" for anything without an explicit arm.

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
- a race where one side had to be discarded; the losing value lands in
  `sync_conflicts` as an invisible diagnostic
  ([SYNC.md](SYNC.md#conflict-diagnostics)) and no issue opens. Legacy
  `conflict` rows are excluded from the issue list and the status count until
  the sweep retires them;
- two local files bound to the same book identity, naming both paths;
- a queued reprojection that failed;
- a forgotten-book snapshot that could not be published or read back, so
  another machine can apply the delete but cannot offer a restore;
- a shared restore that had to replace newer local state on the fresh identity;
- a book file larger than the 256 MiB blob cap, named with its path so the
  user knows which file to shrink.

The Settings > Sync tab shows the state (`Off`, `Up to date`, `Syncing`, `Needs
attention`), last sync, pending local items, books waiting for their file,
issues, and recently deleted items. Invalid operation files are
retried five times before being marked processed with an issue, so one bad file
cannot starve the rest.

The sidebar's Settings entry shows a small dot when sync is on and the engine
reports an error or an open issue. The dot is visible
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
computes from the kind. The renderer never parses an issue key. The action
contract and the self-clearing rules are recorded in
[ADR 0015](adr/0015-sync-recovery.md).

| Kinds                                                                                                                                                                            | Action       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `projection_failed`, `identity_failed`, `reprojection_failed`, `book_lifecycle_failed`, `sync_failed`, `operation_retrying`, `cover_missing`, `cover_blob_failed`, `hash_failed` | Retry        |
| `operation_rejected`                                                                                                                                                             | Open folder  |
| `duplicate_book`, `book_snapshot_missing`, `book_snapshot_invalid`                                                                                                               | Copy details |
| `book_blob_oversize`, `book_file_adopt_failed`                                                                                                                                   | Copy details |
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

Legacy `conflict` rows are never dismissible: the reconcile/expire sweep is
the only thing that closes them, within the 30-day window
([SYNC.md](SYNC.md#conflict-diagnostics)).

### Copy diagnostics

Application Data has a **Copy diagnostics** button for support. Nothing is
collected in the background and nothing is written to disk: the
`sync_diagnostics` command runs only when the button is clicked, then the
JSON is handed to the main process, which writes it to the clipboard (the
renderer's own clipboard write is denied by the permission policy, X-4).

The document carries:

- sync on or off, the live sync state (including a pass that is running),
  the folder, last sync, last error, and counts for pending local items,
  waiting books, open issues, trash, and conflicts;
- up to 20 of the newest books whose content hash failed, with the book id,
  title, path, attempt count, and next retry time;
- up to 20 open conflicts with the id, kind, field, book title, and creation
  time;
- up to 20 recent book-identity merges and up to 20 recent entity merges,
  naming the losing and winning uids and the entity kind. The merge tables
  carry no timestamp, so "recent" means insertion order;
- the sync folder's `library.json` schema, the operation schema, and the
  database migration version.

It deliberately leaves out book contents, annotation text, notes, conflict
winner and loser values, cover bytes, tokens, and every other secret. Folder
paths and book paths are included because Settings already shows them and
support needs them to recognise a report.

With sync off or no folder selected the command still succeeds: it reports
sync as disabled, returns empty sync counts and lists, and keeps the local
hash failures and schema versions. A missing or unreadable `library.json`
reports a null library marker instead of failing the copy.
