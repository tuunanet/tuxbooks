# Provider links

A provider link records that one durable book is also tracked on a third-party
reading service. The link belongs to the book (`book_uid`), never to a file
row, so it survives unwatch, Remove, a move, and a re-import (ADR 0014 D11).

This document is the contract the Hardcover integration builds on. No network
code, OAuth flow, or provider SDK exists in this ticket.

## Stored state

Two tables in `sidecar/migrations/0021_provider_links.sql`:

- `book_provider_links` holds one row per `(book_uid, provider)`: the remote
  id, the provider's last known status, and timestamps. `(provider, remote_id)`
  is unique, so two durable books cannot claim the same remote record.
- `book_provider_pending_progress` holds at most one unsent page-turn per
  link. A later page turn replaces the queued value. The row cascades with
  the link.

The provider status is cached provider data, not a second TuxBooks reading
status. TuxBooks keeps using `reading_progress` for its own state.

## Command contract

All methods take the durable `bookUid`. None of them resolves a file row.

| Method                          | Parameters                                           | Result           |
| ------------------------------- | ---------------------------------------------------- | ---------------- |
| `list_provider_links`           | `bookUid`                                            | `ProviderLink[]` |
| `link_provider_book`            | `bookUid`, `provider`, `remoteId`                    | `ProviderLink`   |
| `unlink_provider_book`          | `bookUid`, `provider`                                | `boolean`        |
| `apply_provider_reading_update` | `bookUid`, `provider`, `status?`, `progressPercent?` | `ProviderLink`   |

`ProviderLink` serializes as `bookUid`, `provider`, `remoteId`, `status`,
`statusUpdatedAt`, `linkedAt`, and `updatedAt`. `status` is one of
`want_to_read`, `reading`, `paused`, `finished`, or `dropped`, or `null` before
the provider reports one. Book and Reading history payloads also include
`providerLinks` so the UI renders the link without another request.

`link_provider_book` is idempotent for the same book and provider. Re-pointing
a link at a different remote id clears the cached status.

## Status mapping

There is one TuxBooks reading model: `reading_progress.progress_percent` is
`NULL` before the book is opened, a value in `0..=100` while reading, and
`100` for finished. The provider status maps onto it as follows.

| Provider status | Durable progress effect                                        |
| --------------- | -------------------------------------------------------------- |
| `want_to_read`  | None. The status is cached on the link.                        |
| `reading`       | Only an explicit `progressPercent` in the update is written.   |
| `paused`        | Only an explicit `progressPercent` in the update is written.   |
| `finished`      | `progress_percent = 100`, the same result as Mark as finished. |
| `dropped`       | Only an explicit `progressPercent` in the update is written.   |

A `finished` update wins over a supplied percentage. A progress-only update
leaves the cached status alone. Both directions accept only `0..=100` and
reject an update that carries neither field.

## Absent books

A book with no file rows is in Reading history. For that book:

- the link and its last known status stay in `book_provider_links`;
- `apply_provider_reading_update` still writes the cached status and the
  durable progress row;
- a page turn is never queued, because
  `book_provider_pending_progress` is written only while the book has a file
  row. There is nothing open to page through;
- re-importing the same bytes reattaches the file to the same `book_uid` and
  the link is visible again.

Remote updates are not local reading activity, so they never write the queue.
The queue is written by `save_reading_progress`, which is called by an open
reader.

## Unlink and Forget

`unlink_provider_book` deletes the local link and its queued page turn. It does
not call the provider and does not delete remote history. Forget (ticket
tuxbooks-ip6.7) calls this operation before the durable record goes away.
Deleting a durable record without calling it also cascades the local link, but
Forget must use the explicit operation so the intent is recorded.

## Fake provider and tests

`sidecar/tests/provider_links.rs` contains a `FakeProvider` that exercises the
same JSON-RPC surface a real adapter would use. It links, pushes remote
status/progress, reads the outgoing queue, and unlinks without opening a
socket. Its journeys cover create/read/remove by `bookUid`, survival across
unwatch, Reading history display, remote updates while absent, no page-turn
queue while absent, queue coalescing while a file is open, and unlink cleanup.

## What Hardcover integration must implement

Outside this module, the Hardcover adapter owns:

1. OAuth, HTTP, retries, and rate limiting. None of that belongs in the
   sidecar until a later ticket.
2. Mapping Hardcover's reading statuses onto the five canonical values above.
   An unmapped status must stay out of the link rather than inventing a new
   local status.
3. Linking a local book with `link_provider_book`, using `bookUid` and the
   Hardcover book id. It must never key on a path or a file row.
4. Pushing remote changes through `apply_provider_reading_update`, including
   changes for books with no current file.
5. Draining `book_provider_pending_progress` after local page turns and
   calling the Hardcover API. No production drain loop exists yet; this ticket
   provides the storage and the coalescing rule. Clearing and retry behaviour
   belongs with the adapter.
6. Treating an absent book as linked, not missing. It can accept remote
   updates, but TuxBooks must not push page turns for it.
7. Calling `unlink_provider_book` on Forget and leaving the remote reading
   history intact.

Cross-device provider links and full sync durability are ticket
tuxbooks-ip6.9. Cross-edition relink is ticket tuxbooks-ip6.8. Neither
changes the storage contract here.
