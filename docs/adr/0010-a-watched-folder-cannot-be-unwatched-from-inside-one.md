# ADR 0010: The watch list holds no folder inside another

Status: accepted
Date: 2026-10-17
Decides: whether a watched folder can sit inside another watched folder, and what unwatching does about the folder above it
Relates to: `CONTEXT.md` (Unwatch, Watched folder), ADR 0007, ADR 0008, ADR 0009

## Context

The library mirrors the watched folders (ADR 0008), and a book belongs to the
deepest watched folder that holds it (`owning_location`). Unwatching removes
the folder's row and purges the books that row owns, and a watched folder's
watch is recursive.

Put those together and a watched folder inside another watched folder does not
hold. Unwatch the inner one and its books leave the catalog, while the folder
above still watches the same files recursively, so the next modify re-imports
them as rows of the folder above — a new id, so the reading progress and
annotations the purge destroyed do not come back with them (bd tuxbooks-yof).
The reconciler cannot help: a stale queued event and honest new activity look
the same, and the guard on the watch list deliberately passes this case,
because the folder above is still registered.

The inner row also buys nothing. The folder above already watches the whole
subtree and the startup and catch-up reconcile already walk it, so the row
adds no coverage, no import, and no sync. What it adds is a row the user can
select and then cannot unwatch on their own — the shape that produced
tuxbooks-yof twice over in UAT, first when unwatching took the siblings with
it, and again when the dialog offered to take the folder above.

Holding the books out with a recorded exclusion was the other way to make an
inner unwatch stick, and it is worse than it looks. The exclusion has to
outlive the row it carves out, so it is durable state nothing in the
interface shows: months later a file in that folder changes, nothing happens,
and the user has no way to see or undo the decision.

## Decision

1. A watched folder never sits inside another watched folder. Importing a
   folder that a watched folder already covers registers nothing and starts
   no watch; the report names it as already covered instead of naming a watch
   that was never started (ADR 0009's disclosure rule, told honestly). The
   other order gets the same treatment: a folder registered before the folder
   above it loses its row the moment the parent is imported.
2. Losing that row is not an unwatch. Unwatch purges a folder's books with
   the row; collapsing does not. The books stay exactly where they are,
   simply owned by the folder above from then on, so no catalog row, reading
   progress, or annotation is lost. On upgrade, migration 0012 applies the
   same rule to watch lists that predate it.
3. Unwatching a folder takes that folder and the books it owns. There is
   nothing further to ask: no folder above it is in the list to take, and no
   folder below it exists as a row. The dialog states the books, the progress
   and annotations, and that files on disk stay untouched.
4. The sidecar still refuses to unwatch a folder inside another watched one,
   naming the folder above. The settings view cannot offer such a path now,
   so this is the guard for a caller that reaches the command directly.

## Considered options

- Ask whether files under the folder may come back through the folder above,
  and record a "no" as a durable exclusion. Rejected. It asks the user to
  reason about a future filesystem event, and the exclusion is invisible
  state that would need its own interface to be undoable.
- Let an inner unwatch happen: a watched folder owns its whole subtree, so
  the books returning is the mirror principle at work. Rejected. Unwatch
  promises the books are gone (ADR 0008), and they return with the id, the
  progress, and the annotations destroyed, which is neither keeping the
  promise nor keeping the book.
- Offer to unwatch the folder above as well, as an earlier version of this
  ADR did. Rejected after UAT (bd tuxbooks-yof). It is honest, but it makes
  removing one subfolder cost the folder above it, and a user who wanted one
  row gone is asked to give up watching its parent. The question also
  multiplied: a folder with watched folders inside it needed a second question
  about those, so one unwatch could ask twice.
- Have that offer take the folder above and everything under it, which is
  what it briefly did. Rejected in UAT: a user unwatching one subfolder lost
  every sibling beside it, though nothing about closing the hole required
  that.
- Keep the inner rows and hide them. Rejected. A row that exists but is not
  shown is the kind of thing that produces a support conversation later, and
  the counts would need rolling up by hand in a second place.

## Consequences

- The folder list in Settings shows only folders that can be unwatched on
  their own, and the count beside each folder is the whole story: `/tmp`
  carries the books of every folder inside it rather than sharing them with
  rows the user cannot act on.
- Unwatching is one rule with no branching. The trade is granularity: to
  remove one subfolder and keep the rest, the user unwatches the folder above
  and adds the survivors back. That is explicit, visible, and the same end
  state the old "keep the folders inside" answer produced.
- Importing a subfolder of a watched folder still brings its books in, so the
  behaviour a user sees is unchanged; only the row they never needed is gone.
- A migration on upgrade flattens existing watch lists. It touches no book
  row, so upgraders keep their catalog, their reading progress, and their
  annotations exactly as they were.
- `owning_location` and the separator-split ancestry rule are unchanged and
  matter more than before: with one row per subtree, the folder above owns
  everything under it, and a sibling like `/libx` is still not inside
  `/lib`.
- ADR 0007's "importing a folder watches it" still holds; this ADR narrows
  it to folders that are not already watched by a folder above.
