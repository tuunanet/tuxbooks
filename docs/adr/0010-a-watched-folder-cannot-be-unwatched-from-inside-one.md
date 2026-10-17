# ADR 0010: A watched folder cannot be unwatched from inside one

Status: accepted
Date: 2026-10-17
Decides: whether unwatching a folder can leave a watched folder above it covering the files it just removed, and what the unwatch dialog asks
Relates to: `CONTEXT.md` (Unwatch, Watched folder), ADR 0007, ADR 0008, ADR 0009

## Context

The library mirrors the watched folders (ADR 0008), and a book belongs to the
deepest watched folder that holds it (`owning_location`). Unwatching removes
the folder's row and purges the books that row owns, and a watched folder's
watch is recursive.

Put those together and unwatching a folder that sits inside a still-watched
folder does not hold. The books leave the catalog, the parent's recursive
watch still covers the same files, and the next modify re-imports them as
parent-owned rows — a new id, so the reading progress and annotations the
purge destroyed do not come back with them (bd tuxbooks-yof). The reconciler
cannot help: a stale queued event and honest new activity look the same, and
the guard on the watch list deliberately passes this case, because the parent
prefix is still registered.

Holding the books out with a recorded exclusion was the other way to make it
stick, and it is worse than it looks. The exclusion has to outlive the row it
carves out, so it is durable state nothing in the interface shows: months
later a file in that folder changes, nothing happens, and the user has no way
to see or undo the decision.

## Decision

1. Unwatching a folder inside a still-watched folder is refused. The refusal
   names the folder above it, and the dialog is where the user meets it: it
   explains that the books would come back, and offers to unwatch the folder
   above instead, stating how many more folders and books that takes. The
   sidecar enforces the same rule, so no caller can create the hole the
   dialog declines to create.
2. The steer takes the folder above and the folders the user selected, and
   nothing else. A watched folder beside them keeps its own watch when its
   parent leaves the list, so it is never dragged along. The dialog says so,
   and counts only what the move actually removes.
3. Unwatching a folder may take every watched folder _under_ it, at any
   depth. The dialog asks when some are watched separately, and keeps them by
   default, because the purge takes reading progress and annotations with it
   and that cannot be undone.
4. No exclusion is recorded anywhere. The watch list in Settings stays the
   only statement of what is watched, so every state this leaves behind is
   one the user can read and change.

## Considered options

- Ask whether files under the folder may come back through the folder above,
  and record a "no" as a durable exclusion. Rejected. It asks the user to
  reason about a future filesystem event, and the exclusion is invisible
  state that would need its own interface to be undoable.
- Let it happen: a watched folder owns its whole subtree, so the books
  returning is the mirror principle at work. Rejected. Unwatch promises the
  books are gone (ADR 0008), and they return with the id, the progress, and
  the annotations destroyed, which is neither keeping the promise nor keeping
  the book.
- Offer to unwatch the folder above as well, which is what the dialog does.
  Accepted. The move it offers ends in a state the library can express, and
  the cost is stated before the user commits to it.
- Have the steer take the folder above and everything under it. Rejected in
  UAT (bd tuxbooks-yof): a user unwatching one subfolder lost every sibling
  beside it, though nothing about closing the hole required that. A sibling's
  own watch survives its parent leaving the watch list, so it never had to
  go.

## Consequences

- Unwatching a nested folder takes the folder above it and the folders the
  user selected. Siblings keep watching on their own, with their books
  intact, and the dialog names them as staying rather than as leaving.
- The purge reaches every folder the call names. The book count in the
  dialog describes that set, not the whole subtree under the folder above.
- A watched folder left behind by a steer is the ordinary case now, so the
  re-registration the watcher does for a surviving subfolder is on the main
  path rather than an edge.
- Unwatching a folder that has watched folders inside it still offers the
  cascade, and that cascade does take the whole subtree at any depth.
- ADR 0007's "importing a folder watches it" still holds; this ADR only
  constrains the way back out.
