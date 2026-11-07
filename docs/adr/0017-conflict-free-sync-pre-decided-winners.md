# ADR 0017: Conflict-free sync with pre-decided winners

Status: accepted
Date: 2026-11-07
Decides: the winner of every sync race, the removal of conflict review, write-time clock minting, and automatic retry for failure kinds
Supersedes: ADR 0015 D2 and D4 (the conflict prompt and the Conflict review surface), plus the conflict-counting part of D8
Relates to: ADR 0013 (cloud-folder sync), ADR 0015 (sync recovery), `CONTEXT.md` (Tombstone, Sync issue, Sync attention; Conflict review retires), `docs/SYNC.md`, `docs/SYNC_ISSUES.md`, `docs/DATABASE.md`

## Context

ADR 0015 gave every sync failure one real action and removed manual error
repair. One manual surface survived: Conflict review. It is also the dominant
complaint about sync. Every device race opens a `sync_conflicts` row plus a
`sync_issues` row (`record_conflict` in `sidecar/src/sync/merge.rs`), and the
pair sits in review until the user settles it or the 30-day expiry
(`conflict::expire`, `TRASH_DAYS`) deletes it. Two devices that touch the same
annotation produce review rows as a matter of course.

Races surface through five paths today:

- a per-field write loses at tie-or-older HLC, for annotations, metadata
  overrides, and collections;
- an edit arrives after a delete and is diverted as `__deleted__`;
- a restore races a delete and is recorded as `__restore__`;
- an entity-mode write loses as `__entity__`;
- a local edit touches a tombstoned entity and is kept as a tombstone
  conflict.

ADR 0015 already contains the precedent for a different answer: "Progress and
other additive state never ask the user for a choice." Progress already
resolves this way. The winner stays applied, the losing locator is kept for
diagnostics only, and no prompt exists for it.

Two more problems hide behind the review flow.

Hybrid clocks mint at publish time, not write time. The dirty triggers enqueue
snapshots with no clock, and `build_op` calls `next_hlc` when the capture pass
drains the queue. A device offline for a month stamps its month-old edits with
reconnect-time clocks, and those clocks win last-writer-wins against
everything written since. Every device still converges; they converge on the
wrong winner.

And the failure kinds that cannot self-clear still wait for a Retry press.
Conflicts die by design. Failures such as hash failures, projection errors,
and rejected operations remain, and a healthy library should not need a human
to press Retry on them.

## Decisions

### D1. Every race has a pre-decided winner; nothing opens review

Humans act, the HLC clock orders, diagnostics record. No race asks a user to
choose.

- Edit versus edit resolves per field by newer HLC. The comparison is already
  total: `Hlc` orders by wall clock, then counter, then device id, so a tie
  breaks deterministically.
- Edit versus delete is remove-wins. A tombstone kills any later-arriving
  edit of that entity, whether the edit arrives from the folder or from a
  local write.
- Restore versus delete and entity-mode races resolve by HLC order.

All three pseudo-field outcomes (`__deleted__`, `__restore__`, `__entity__`)
become silent. The losing value still lands in `sync_conflicts`, but nothing
counts it, lists it, or asks about it. The Progress carve-out stops being an
exception and becomes the rule for every kind.

`conflict::expire` stays. It is diagnostics retention, not review pressure: a
row older than 30 days is deleted, which keeps the diagnostics trail bounded.

### D2. Conflict review is removed

The SyncConflictsSection keep and keep-all flow in Settings > Sync and the
settle and apply-loser IPC behind it (`conflict::settle` and the conflict
resolution validation in the Electron main permission policy) are removed in a
companion task. The sidebar dot and the Settings > Sync counts stop counting
conflicts-to-review, so sync attention reports open issues and errors only.

`sync_conflicts` remains as invisible diagnostics. It has no interactive
surface: nothing to settle, nothing to apply, and no count in the live UI.
Copy diagnostics keeps its conflict sample, which is a support report on
demand, not a review flow.

### D3. Clocks mint at write time, not publish time

The fix lands in a companion task. `sync_dirty` gains HLC columns, filled by
the same single-statement upsert `next_hlc` uses today, inside the write
transaction that already touches the row. SQLite serializes write
transactions, so the mint is atomic with the write it dates. `build_op`
consumes the stored clock and stops minting its own.

The acceptance case: device A edits at T1 while offline, device B edits at T2
with T1 < T2 while A is still offline. A reconnects and publishes later. B
still wins, because B's write carries the newer clock no matter when A gets
around to publishing.

Clock minting stays at operation granularity: one clock per operation, shared
by the fields it carries. The merge still compares per field, against the
clock of the operation that wrote each stored value. Per-field clocks are
explicitly not introduced.

### D4. Failure kinds retry on a schedule, not on command

A sweep hooks the engine loop after each pass, while holding `pass_lock`, and
dispatches due rows through the `retry_locked` arms inline. It never calls
`retry_issue`, which takes `pass_lock` itself; the sweep already holds it.

Each kind gets a cap: 5 attempts by default, 3 for `book_lifecycle_failed`.
Backoff reuses `RETRY_DELAYS_SECS` from the hash backfill: 60 seconds, 5
minutes, 15 minutes, 1 hour, 6 hours, then 24 hours as the cap. `hash_failed`
is excluded from the sweep; its existing backfill loop already is the
schedule.

Folder-dependent kinds (`sync_failed`, `cover_missing`, `cover_blob_failed`,
`operation_retrying`, `book_lifecycle_failed`) skip while the folder is
disconnected. A skip is not an attempt and does not move the backoff clock;
the row keeps its budget for when the folder returns.

A manual Retry resets the counter and revives exhausted rows. An exhausted
row stays open with a gave-up detail. Sync attention then means one of two
things: the machine gave up, or a human is required. It never means work is
in progress. A default-on Settings toggle is the kill switch.

### D5. Silence is safe because the system remembers

Three mechanisms together are the memory model: forever-tombstones
(`sync_state_entities` keeps `deleted = 1` rows with their delete HLC and
never removes them), the no-GC operation folder, and the `sync_applied_ops`
dedupe table. They are what stops a late edit from resurrecting a deleted
annotation, which is the one way silent resolution could lose data.

Any future compaction of the operation folder must be tombstone-aware. Prune
a delete operation before every device has applied it and resurrection
returns.

Convergence holds because every device applies the same HLC order over the
same never-pruned operation set. One benign caveat is part of the design: an
edit operation arriving at a device that never saw the entity applies fresh,
and the still-present delete operation processes later. Convergence is
preserved.

## Consequences

- The review flow and its IPC and UI go away entirely. No successor surface
  asks users to settle anything.
- Sync issues shrink to genuine failures, and D4 retries those
  automatically. Rows that reach the user are rows the machine gave up on.
- Clock minting stays at operation granularity. Per-field clocks are not
  introduced; if a future feature seems to need them, that is a new decision,
  not an extension of this one.
- Diagnostics rows keep no user-facing surface. Support reads them through
  Copy diagnostics; nobody settles them.
- The Conflict review entry in `CONTEXT.md` retires, along with the
  conflict-review wording in `docs/SYNC.md` and `docs/SYNC_ISSUES.md`, when
  the companion task lands.
- ADR 0015 D3's sentence "A delete wins over a concurrent edit and keeps the
  edit as a conflict" stays true; only what "keeps" means changes. The edit
  is kept as diagnostics, not as a pending choice.

## Risks accepted

- A single global reading position ping-pongs between alternately used
  devices. That is inherent to latest-wins on a whole-record value.
- The same passage highlighted independently on two offline devices yields
  two cosmetic duplicates. Content-based dedupe is deliberately rejected: it
  would false-merge intentionally distinct highlights, such as the same
  sentence highlighted twice, and near-identical selections of different
  intent.
- A forget snapshot larger than `MAX_FIELD_STRING_BYTES` is dropped with an
  issue, so restores degrade for very large books.
- Remove-wins discards a real edit without telling the user at the time of
  the edit. The value stays in `sync_conflicts` for support, but nobody is
  asked. This reverses the exact case ADR 0015 D2 was written to prompt on,
  and it is accepted because review-per-race did not survive contact with
  real libraries.

## References

- `docs/SYNC.md` for the protocol and the merge table.
- `docs/SYNC_ISSUES.md` for issue kinds, actions, and self-clearing rules.
- `docs/DATABASE.md` for `sync_conflicts`, `sync_dirty`,
  `sync_state_entities`, and `sync_applied_ops`.
- `CONTEXT.md` for Tombstone, Sync issue, and Sync attention.
- ADR 0013 for the operation-log design; ADR 0015 for the recovery flow this
  amends.
- `sidecar/src/sync/merge.rs` (`record_conflict`, `apply_delete`),
  `sidecar/src/sync/capture.rs` (`build_op`, the tombstone guard),
  `sidecar/src/sync/clock.rs` (`next_hlc`), `sidecar/src/sync/conflict.rs`
  (`expire`, `settle`), `sidecar/src/sync/engine.rs` (the pass loop,
  `retry_locked`, `retry_issue`), `sidecar/src/sync/model.rs` (`Hlc`,
  `TRASH_DAYS`), and `sidecar/src/repository/identity_backfill.rs`
  (`RETRY_DELAYS_SECS`).
- Migration 0023 for the dirty triggers.
- `frontend/src/components/settings/SyncLists.tsx` (SyncConflictsSection) and
  `electron/main/ipcPolicy.ts` (conflict resolution validation) for the
  surfaces D2 removes.
