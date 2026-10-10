# ADR 0008: Unwatch removes the books and the loose mechanism is retired

Status: accepted
Date: 2026-10-10
Decides: what unwatching does to the folder's books, and whether books outside every watched folder exist as a class
Relates to: `CONTEXT.md` (Unwatch, Watched folder), ADR 0006, ADR 0007

## Context

The library mirrors the watched folders. Every catalog row came from a folder
the user watches, and reconciliation keeps it in step. Two recorded stances
contradict that mirror.

ADR 0006 named the exception. A book no watched location owns is loose, it
lives in its own Outside Watched Folders view, and every book on the wire
carries a `loose` flag so the view knows its members. ADR 0007 shipped
unwatch with keep-the-books on by default and remove-from-catalog as an
opt-in checkbox.

Neither stance pays for itself. The kept and the loose books are rows that no
watched folder produced and nothing will ever reconcile, and the sidebar
entry, the dedicated view, the Data tab row, and the per-book flag exist only
to explain that shadow category to the user.

## Decision

1. Unwatching removes every catalog book the unwatched folders own. The
   confirmation dialog stays, because the step is destructive, and its text
   now warns that reading progress and annotations go with the books, next to
   the standing promise that files on disk are untouched. The keep/remove
   choice is gone; there is one outcome.
2. The loose mechanism is retired. The flag leaves the wire and the frontend
   book type, and the sidebar item, the view, the section maps, and the Data
   tab row go with them. On upgrade a one-time migration purges the rows
   outside every watched folder, files stay on disk, and the glossary drops
   the term. The path-ancestry helper stays: storage reporting still groups
   content by watched location through it, and the sibling-prefix guard
   (`/libx` is not under `/lib`) still holds for that grouping.

## Considered options

- Keep the books on unwatch, as before. Rejected. The library stops meaning
  what I watch, and the user has to find and delete the leftovers by hand.
- Keep the loose category but hide it. Rejected. The mechanism is complexity
  with no payoff: a flag on every payload, a fallback that redirected the
  selection when the last loose book vanished, and copy that had to explain a
  second category inside a library view.
- Delete the files on unwatch or during the upgrade purge. Rejected. TuxBooks
  never destroys user files; both steps promise the files stay on disk.

## Consequences

- Unwatch destroys catalog metadata for those books, reading progress and
  annotations included. The dialog says so before the user confirms.
- Upgraders lose the outside-watched rows once, with their progress and
  annotations. The files stay where they are and return to the catalog if the
  user watches the folder later.
- No code can build on a `loose` field: the wire, the type, and the section
  maps no longer offer one.
- A book whose file vanishes inside a watched folder keeps the existing
  unavailable-until-relocated behaviour. That shock absorber is untouched.
- ADR 0006's loose stance and ADR 0007's keep-by-default stance no longer
  hold. ADR 0006 also records the single-file import policy, which a separate
  ADR reverses.
