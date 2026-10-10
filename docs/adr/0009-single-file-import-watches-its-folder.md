# ADR 0009: A single-file import watches its folder

Status: accepted
Date: 2026-10-10
Decides: whether importing one book adds its folder to the watched locations (supersedes ADR 0006)
Relates to: `CONTEXT.md` (Watched folder), ADR 0006, ADR 0007, ADR 0008

## Context

ADR 0006 kept single-file imports unwatched and let the leftovers live as
loose books. ADR 0008 retired the loose mechanism and made the library a
strict mirror of the watched folders: every catalog row comes from a folder
the user watches. A picked file that stays outside every watched folder
breaks that mirror the moment it lands, and nothing would ever reconcile
it. Import Files, drag-and-drop, and the empty-library picker all feed the
same command, so the stray file keeps arriving through all three.

## Decision

1. Importing a plain file registers its parent directory as a watched
   location, scans that directory for books, and starts the filesystem
   watcher — the same treatment a folder import gets. The folder's whole
   book set arrives with the picked file.
2. Registering an already-watched parent is idempotent: no duplicate
   location row, no error, and no second watch disclosure.
3. The import report lists every folder the run newly registered, and the
   import status discloses it ("Watching …"). Watching never happens
   silently.
4. A file that is not a supported book still fails as before, and its
   folder stays unwatched: a failed import registers nothing.

## Considered options

- Keep single-file imports unwatched (ADR 0006). Rejected. The mirror
  would keep a permanent outside class with nothing to reconcile it; the
  loose mechanism that used to absorb these books is gone.
- Watch the parent only after an extra confirmation. Rejected. A second
  dialog on every stray import is friction for the outcome the user
  already asked for: the book, plus everything beside it, kept in step.
- Drop single-file import entirely. Rejected. Import Files is a requested,
  habitual flow.

## Consequences

- A stray import turns its folder into a watched folder: neighbors on disk
  enter the catalog and stay in sync until the user unwatches, which
  removes the books (ADR 0008) while the files stay on disk.
- Import Files, drag-and-drop, and the folder picker all disclose the new
  watch through the same import report and status copy.
- The parent's scan failure is reported per path like any other import
  failure; the picked file itself still imports.
- ADR 0006 no longer holds; this ADR supersedes it.
