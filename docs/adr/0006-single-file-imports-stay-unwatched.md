# ADR 0006: Single-file imports stay unwatched

Status: accepted
Date: 2026-09-23
Decides: whether importing one book adds its folder to the watched locations
Relates to: `CONTEXT.md` (Watched folder, Loose book)

## Context

The user can add books two ways: import a folder, which registers it as a
watched location, or import individual files. A single file carries no promise
about the rest of its directory. The user picked that file, not the folder
around it, and that folder may hold unrelated documents, other people's books,
or thousands of files. The library still has to show the imported book, because
the user asked for it and expects to find it.

## Decision

1. A single-file import stores the book row and leaves the watched locations
   unchanged. The file's directory is never watched.
2. A book whose path no watched location owns is loose. The library shows loose
   books in their own Outside Watched Folders view.
3. Only a folder import registers a location. Reconciliation and filesystem
   events cover books inside watched locations only.

## Considered options

- Watch the file's parent directory automatically. Rejected. The user chose a
  file, not a folder, and the app should not import or reconcile neighbors they
  never asked for.
- Drop the book row and refuse single-file imports. Rejected. It breaks a
  requested feature and loses the import the user made.

## Consequences

- Loose books do not react to filesystem changes. If the file moves, the book
  goes unavailable and the user reconnects it by hand.
- A loose book becomes watched once the user adds a folder that contains it.
- The user can make any loose book watched later by importing its folder.
