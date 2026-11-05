# Sync issues

Every sync problem the renderer shows lives in the `sync_issues` table,
one row per issue key. This is the map: who writes a row, when it closes
on its own, and what Retry does. Conflicts are the exception: they live in
`sync_conflicts` and are settled in the review section, never through this
flow.

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

| kind                                             | recorded by                                              | closes when                                            | Retry does                                                       |
| ------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| `projection_failed`                              | `merge.rs`, `project_book`                               | the book row is gone                                   | reprojects the book's file row                                   |
| `identity_failed`                                | `merge.rs`, identity sweep                               | the book row is gone                                   | hashes the book and reprojects; a vanished book reports gone     |
| `reprojection_failed`                            | `merge.rs`, `project_book`                               | the record is gone and no binding remains              | reprojects, or books the uid gone                                |
| `book_lifecycle_failed`                          | `merge.rs`, `project_book_lifecycle`                     | the uid has no `book_records` row                      | replays `retry_book_lifecycle` from the mirror, then runs a pass |
| `sync_failed`                                    | `engine.rs`, `run_pass_locked` (key `sync-pass`)         | a later pass succeeds (`clear_error` resolves the key) | runs a pass; requires a connected folder                         |
| `operation_retrying`                             | `engine.rs`, `record_file_failure` (key `file:...`)      | the folder file is applied or removed                  | re-reads the file                                                |
| `operation_rejected`                             | `engine.rs`, `record_file_failure` after the retry limit | same as `operation_retrying`                           | not Retry: the action is "open folder", the file must be fixed   |
| `hash_failed`                                    | `services/hash_backfill.rs` (key `hash-failed:...`)      | the whole book hashes clean (or the book is gone)      | resets the hash budget and hashes the book now                   |
| `cover_missing`                                  | `engine.rs`, `sync_remote`                               | the cover blob arrived                                 | reapplies the cover                                              |
| `cover_blob_failed`                              | `engine.rs`, `sync_remote`                               | the blob exists in the folder                          | stores the blob from the folder and reapplies                    |
| `duplicate_book`                                 | `sync/identity.rs`, `record_duplicate_bindings`          | the book is back to one binding                        | none; informational                                              |
| `invalid_dirty_kind`                             | `capture.rs`                                             | never; action is Dismiss                               | none                                                             |
| `book_snapshot_missing`, `book_snapshot_invalid` | `repository/lifecycle.rs`, `capture.rs`, `merge.rs`      | never; action is CopyDetails                           | none; the delete applied, no local restore is available          |
| `forget_membership_skipped`                      | `repository/lifecycle.rs`                                | never; action is CopyDetails                           | none; the snapshot named shelves this library does not have yet  |
| `restore_conflict`                               | `repository/lifecycle.rs`, `apply_remote_restore`        | never; action is CopyDetails                           | none; review carries the choice                                  |

Two invariants worth knowing before changing anything here:

- Recording twice on an open row keeps one row (same id, new detail);
  recording after a resolution opens a second row. The resolved row never
  reopens.
- The kind set is small and closed on the action side: a new kind that
  `for_kind` does not know falls through to CopyDetails, and `retry_locked`
  answers "no retry path" for anything without an explicit arm.
