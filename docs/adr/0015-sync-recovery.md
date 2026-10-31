# ADR 0015: Sync recovery without manual error resolution

Status: accepted
Date: 2026-10-31
Decides: how sync reports and repairs failures, when a conflict reaches the user, what happens to the losing value, and how the sync recovery work lands on main
Relates to: ADR 0013 (cloud-folder sync), ADR 0014 (durable books and reading history), `CONTEXT.md` (Sync issue, Conflict review, Sync attention), `docs/SYNC.md`, `docs/DATABASE.md`, `docs/COVERAGE.md`

## Context

Settings > Sync could report a problem but rarely helped fix it. Every issue row
offered only Dismiss, so the user had to guess whether retrying, opening the
folder, or waiting was the right move. The Book identity index in Settings >
Application Data listed automatic merge notices with internal uuids and another
Dismiss button. It grew without limit and described decisions the user could
not act on.

The conflict path had the opposite problem. A last-writer-wins merge could
discard a value the user had written on another machine. The losing value was
stored in `sync_conflicts`, but nothing in the UI showed it, so a silent
overwrite could lose a user edit with no path back.

Three properties had to hold together: a failure should carry a repair,
automatic merges should stay out of the user's way, and an overwrite that would
lose a real edit should be reviewable without blocking sync.

## Decisions

### D1. Sync does not ask the user to resolve an error

Sync retries, converges, recovers, and pauses when it cannot proceed. A failure
becomes a `sync_issues` row with an action that does the work the kind needs, or
it stays on the affected book when sync is off. No error path asks the user to
interpret an internal id or choose between technical outcomes.

The existing confirmations for a library mismatch, a Forget restore, and a
cross-edition relink are unchanged. They confirm what the user means to do with
their data, not how to repair a failed sync pass.

### D2. The only recovery prompt is a conflict that would discard a differing user edit

A conflict reaches Conflict review only when automatic resolution would replace
a value the user wrote with a different value. Identical writes, additive
changes, and values that only one side changed never prompt. Progress never
prompts, even when its locator differs: the current winner stays applied and the
losing locator stays in `sync_conflicts` for diagnostics only.

Book identity merges are deterministic (the smallest uuid wins) and are
keep-only. Replaying the losing identity would resurrect a book every device
already collapsed.

### D3. The merge rules stay field-level LWW with add/add union

Annotations, metadata overrides, and collections keep per-field hybrid logical
clocks. Reading progress, collection membership, and last opened stay
entity-level, because a locator or membership assembled from two machines is not
a value either machine wrote. Two independently added annotations or memberships
union; they do not prompt. A delete wins over a concurrent edit and keeps the
edit as a conflict.

The merge result itself is ADR 0013 D5 and D6 unchanged. The recovery work adds
a review surface, not a new merge algorithm.

### D4. Conflict review lives in Settings > Sync

Conflicts are listed in the Settings tab, grouped by book with delete/edit rows
first, then whole-entity rows, then single fields. There is no modal during a
sync pass and no prompt that blocks reading or the library.

The current winner stays applied until the user resolves. The losing value stays
in `sync_conflicts` until resolution or the 30-day expiry, whichever comes
first. The row carries the kind, entity, field, both JSON values, both clocks
with the writing device, and the recording time. Device names fall back to
stored device ids when the sync folder is unavailable.

Two resolutions are offered. Keep winner stamps `resolved_at` and changes no
state. Apply loser publishes the discarded value as a normal synced operation
with a fresh hybrid clock, so every device replays it and converges. A
delete/edit or lost-restore conflict republishes the explicit restore
operation, which also closes the matching trash entry on every device that
applies it. A resolution never deletes the losing value from the row, so the
audit trail remains.

Delete/edit is the flagship case: one machine deletes an annotation while
another edits it. The delete wins, the edit is retained as a conflict, and
applying the loser restores the annotation through the normal restore path.

The queue is reconciled against the mirror on every status refresh and before
every list. A row closes when a newer write has moved the value or clock past
its winner, so a device that replays another device's resolution settles its own
copy.

### D5. Every sync issue has one real action and clears itself

The sidecar computes the action from the issue kind, so the renderer never
parses an issue key.

- Retry covers projection, identity, reprojection, book lifecycle, failed pass,
  operation retrying, missing cover, cover publish, and hash failures. It runs
  the work the kind needs, not just another background wake-up.
- Open folder covers a rejected operation that passed the retry limit. The file
  has to be fixed or removed in the sync folder.
- Copy details covers duplicate bindings and a missing or invalid forgotten-book
  snapshot.
- Dismiss is the primary action only for an unknown dirty kind that is cleared
  as it is reported. Copy details is informational too, so rows with either
  action can be dismissed from the UI; dismissal is separate from the primary
  action.

A status refresh closes rows whose condition is gone: the duplicate binding
disappeared, the operation applied cleanly or its file is gone, the missing
cover was applied to the book, a later identity or reprojection pass succeeded,
the book is gone, the hash succeeded, or a successful pass closed `sync_failed`.
An actionable row cannot be dismissed, and Dismiss all closes only informational
rows.

Conflicts are excluded from the Sync issues list and its count. They are
counted and shown by Conflict review, which owns them until the user settles
them, so Dismiss can never hide a conflict without resolving it.

### D6. Hash failures retry on a bounded schedule and surface on the book

A failed content hash retries automatically after 1 minute, 5 minutes, 15
minutes, 1 hour, 6 hours, then 24 hours as the cap. The attempt count keeps
growing; only the delay is capped. A file snapshot change, a returning file, a
relink, or a metadata rewrite returns the row to pending with a clean budget. A
successful hash clears the retry clock.

With sync on, one `hash_failed` issue is opened per book, not per location, and
its Retry runs the index pass for every available location starting from a clean
backoff. With sync off, the book itself shows the warning and the same Retry
indexing action. A book is failed when any of its locations failed.

### D7. A waiting book attaches only from its exact bytes

Locate file hashes the picked file and looks up the content-hash aliases. The
alias must already exist and must resolve to the waiting book. If the alias is
missing or names a different book, the command refuses, adds nothing to the
library, and leaves the row waiting. A different edition therefore never
inherits another book's annotations or progress.

On a match, the sidecar creates the durable record for the waiting uid when this
machine never had one, attaches the file to that identity, and projects
progress, annotations, metadata overrides, collection membership, and last
opened. A failed attach removes a record it created, so it adds nothing to
Reading history.

### D8. Sync attention is visible outside Settings

The sidebar's Settings entry shows a dot when sync is on and the engine reports
an error, an open issue, or a conflict to review. The dot is visible wherever
the sidebar is, including while Settings is open. A toast appears once when the
state changes into attention, not on first load and not on every status update.
It sits bottom-center, is hidden in the reader, and does not block reading or
library interaction. Resolving the condition clears both. A dismissed toast
stays hidden until attention clears and later returns, and the toast does not
auto-dismiss.

### D9. The Book identity index is replaced by Copy diagnostics

The Book identity index card and its per-merge notices are removed. Identity
merges stay silent and keep their audit trail in `sync_book_merges` and
`sync_entity_merges`. A duplicate copy is reported as an actionable sync issue
instead.

Settings > Application Data offers Copy diagnostics. Nothing is collected in the
background and nothing is written to disk; the command runs only when the button
is clicked and the renderer writes the JSON to the clipboard. The report carries
sync state and counts, up to 20 failed hashes, up to 20 open conflicts, up to 20
recent book-identity merges, up to 20 recent entity merges, and the schema and
migration versions. It deliberately leaves out book contents, annotation text,
notes, conflict winner and loser values, cover bytes, tokens, and every other
secret. Folder paths and book paths are included because Settings already shows
them and support needs them to recognise a report.

### D10. Sync coverage stays at 92%

The Cloud sync category in `docs/COVERAGE.md` requires 92% line coverage and is
enforced by `scripts/coverage-gate.mjs` through `just coverage`. The coverage
ticket measured 92.3% on the production-only count (segments before
`#[cfg(test)]`), which is the measurement the review uses. `just coverage`
reported 98.3% for the module because llvm-cov includes inline test lines.

The floor is a module floor. When the floor was set, `identity.rs` and
`waiting.rs` sat below 92% on the production-only count because their remaining
uncovered lines were dead branch bodies or the error edge of a multi-line
await, not lines that failed to execute. `docs/COVERAGE.md` records both the
floor and the exception.

### D11. The epic lands through an integration branch

Task branches are cut from `epic/sync-recovery`, which is cut from `origin/main`.
Task pull requests target the epic branch and merge only when green. When every
ticket closes, one pull request goes from the epic branch to `main` after
`just check`, `just coverage` with sync at or above 92%, and E2E pass. `main`
never receives partial epic work.

## Consequences

- Conflicts are rare but can stay open. Settings shows a count until the user
  resolves the row or the 30-day window expires.
- The losing value survives 30 days. After that the row is deleted during a
  status refresh or a list, so the value is no longer offered in review.
- Automatic retry is bounded. A permanently unreadable file keeps failing on the
  24-hour cap and stays visible on the book until the file or the permissions
  change.
- The coverage gate distinguishes production lines from inline test lines, so
  the module can clear 92% while individual files sit below it. The reason is
  recorded in `docs/COVERAGE.md`.
- Settings no longer grows with merge notices. Support depends on Copy
  diagnostics and on the issue action rather than on a list of internal uuids.
- Every new issue kind must declare an action. A kind that defaults to Copy
  details is informational and dismissible; a new actionable kind needs a retry
  path or it will sit open.
- Conflict review adds a second surface that must stay reconciled with the
  mirror. Every status refresh and list pays one reconciliation pass.

## Risks accepted

- A user can leave a conflict open for 30 days and live with the applied winner.
  The alternative, blocking sync until every conflict is settled, is worse.
- Applying the loser is not always safe. The backend can disable it with a
  reason, for example when replaying an identity would resurrect a merged uuid.
- A resolve on one device can be replayed later by another. The queue reconciles
  against the mirror, so a stale row closes instead of offering a choice that no
  longer exists.
- Copy diagnostics includes absolute folder and book paths. Settings already
  shows them, and support needs them to recognise a report; the payload is still
  user-initiated and never uploaded by the app.

## References

- `docs/SYNC.md` for the protocol, issue actions, conflict review, and test
  inventory.
- `docs/DATABASE.md` for `sync_issues`, `sync_conflicts`, `sync_book_merges`,
  and the hash retry columns.
- `docs/COVERAGE.md` for the 92% floor and the production-only measurement.
- `CONTEXT.md` for Sync issue, Conflict review, and Sync attention.
- `sidecar/src/sync/conflict.rs`, `sidecar/src/sync/engine.rs`, and
  `sidecar/src/repository/identity_backfill.rs`.
- Migrations 0026, 0027, and 0028.
- ADR 0013, ADR 0014.
