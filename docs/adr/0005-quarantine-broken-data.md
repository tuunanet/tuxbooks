# ADR 0005: Quarantine broken data and never touch books on recovery

Status: accepted
Date: 2026-09-22
Decides: how startup recovery and reset treat a broken database and the user's book files
Relates to: `CONTEXT.md` (App data, Cache)

## Context

TuxBooks holds two things it cannot rebuild: the catalog database, which is the
only copy of the index, and the user's book files, which the app never created.
When the database will not open, fails an integrity check, or fails migrations,
the app cannot start, and the quickest fix is to delete the database and start
over. A reset path has the same temptation: clear the data root and book files
will look like app data. Both moves destroy something the user cannot get back.
The catalog carries reading progress and annotations, which nothing regenerates,
and book files are the user's own library.

## Decision

1. A database that will not open, fails an integrity check, or fails migrations
   is quarantined, never deleted. The app moves it and its sidecar files aside
   under a timestamped name, starts with a fresh database, and reports where the
   quarantined copy went.
2. Every reset path leaves book files and watched locations untouched. Reset
   clears app data only.

## Considered options

- Delete the broken database and start fresh. Rejected. It destroys the only
  copy of the catalog and leaves nothing to diagnose.
- Refuse to start and ask the user to fix it by hand. Rejected. It leaves a user
  who cannot read a log or edit files with no way forward.
- Let reset remove book files or watched locations. Rejected. Those are the
  user's files, not app data, so no reset path may touch them.

## Consequences

- Quarantined copies accumulate until the user removes them, and the app says
  where each one went.
- Startup always makes progress: a fresh database replaces the broken one.
- The rule matches how the app already treats books: it indexes them in place
  and treats the files as read-only.
