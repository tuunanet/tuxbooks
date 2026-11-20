# ADR 0019: Locate File resolves a duplicate without guessing

Status: accepted
Date: 2026-11-20
Decides: the automatic merge rules when a missing book's picked file already
belongs to another library entry, the conflict choices, and the provider and
edition links that survive an identity merge
Relates to: ADR 0014 (durable books), ADR 0015 (sync recovery), ADR 0017
(pre-decided winners), `docs/SYNC.md`, `sidecar/src/services/locate_file.rs`

## Context

A move or a re-import can leave a missing entry in the library while the same
file already belongs to a second entry. Locate File used to refuse that pick
with "that file is already in the library", and the renderer only logged the
refusal. The user saw the picker close and nothing happen.

The refusal protects user state. Annotations, highlights, and bookmarks are
bound to the file's text and layout: EPUB locators use CFIs and PDF highlights
use page rectangles. Merging two different files can make those locators
disappear or land on the wrong passage.

The identity merge already exists for the case it was designed for: two
devices imported the same content hash and must converge on one durable book.
That path moves progress, annotations, collections, metadata overrides,
last-opened, and file rows in one transaction.

## Decisions

### D1. The picked path decides between reconnect, detach, merge, and conflict

`locate_book` looks the picked path up in the library.

- No row owns the path: reconnect the missing book, as before.
- The path is another file row of the same durable book: revive that row and
  report the refreshed book.
- The path belongs to another durable book: apply D2.

### D2. Detach an empty candidate, merge only matching bytes

The candidate (the missing entry) has no user state when it has no progress,
annotations, collections, metadata overrides, provider links, or edition
links. Such an entry detaches to Reading history: its missing file row is
removed and its durable record stays. There is nothing to merge and no
different-bytes identity merge is needed.

When the candidate has state, it merges into the owner only if the picked
bytes match one of the candidate's bound content hashes. A missing binding
means the app cannot prove the bytes are identical, so it asks. Last-opened
alone does not count as state.

### D3. A different-bytes conflict offers only lossless choices

The response carries the owner, the candidate, and the candidate's state
counts. The UI offers:

- open the owner and keep both entries;
- move the candidate to Reading history (the file row is removed, the durable
  record and its state stay);
- link the candidate to the owner as a different edition. The link moves
  provider links but keeps the candidate's progress and annotations, and does
  not overwrite the owner's reading position.

None of these merges state silently.

### D4. An identity merge carries provider and edition links

Provider links are local state. The merge keeps the winner's link when both
sides have the same provider; otherwise the loser's link moves. Queued
provider progress follows a link only when that link moves. Edition links to
third books are re-keyed onto the winner; a link that would become a self-link
is dropped.

### D5. Only matching bytes merge identities

Sync converges identities through shared content hashes. A Locate File merge
uses that same path, so it carries the provider and edition links and
propagates the way any content-hash convergence does. A different-bytes
candidate is never identity-merged: an empty one detaches to Reading history
under its own uid, and one with state asks the user. Later remote state for a
detached candidate stays on that candidate, not on the owner.

## Consequences

An empty duplicate leaves the library and waits in Reading history. A
same-bytes duplicate merges and keeps every locator valid. A different-bytes
duplicate with state keeps its state and asks the user. The owner keeps its
own file rows; a detached candidate does not add a missing location to it.

The merge is transactional. Provider and edition links survive, and no path
deletes the candidate's durable record before its state has moved.
