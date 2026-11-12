# ADR 0016: Collections are library places selected from the sidebar

Status: accepted (amended 2026-11-12: the sort control offers concrete per-place orders)
Date: 2026-11-01
Decides: how collections are selected and presented in the library, how multiple collections combine, and what pinning and ordering mean
Relates to: `CONTEXT.md` (Collection, Collection membership, Library place, Smart section, Pinned collection), ADR 0012, ADR 0014

## Context

Collections are currently a single sidebar section per collection. They are
listed alphabetically with no ordering, pinning, multi-selection, rename, or
delete confirmation. The library header also has a sort control whose options
include Recently Added and Recently Read, which are also sidebar destinations.

The first version of this redesign added a collection dropdown in the header
beside the sidebar collection list. That gives two controls the same inventory
and the same selection state. The dropdown has no job the sidebar cannot do,
and the header already carries search, format, sort, import, and view controls.

ADR 0012 established format as a multi-select header filter that composes with
every section and collection. Collections are a different axis. They are places
to go, not filters to apply. Making collections a filter would leave two active
dimensions in the sidebar and let a collection restriction follow the user into
an unrelated smart section.

## Decision

1. Collections are library places, not filters. Selecting a collection replaces
   the current place. Selecting a smart section clears the collection
   selection. A collection place is one collection or a union of several
   selected collections.
2. The sidebar is the single collection picker. There is no collection dropdown
   or filter in the library header. All Books is the reset; clicking it clears
   the collection selection, and Ctrl+clicking the last selected collection
   also falls back to All Books. The library title names one collection, names
   two, and counts three or more.
3. Collections are grouped into Pinned Collections and Unpinned Collections.
   Pinning changes only placement; every collection stays visible. Pin state
   and custom order are per-device UI preferences keyed by the local collection
   id. They do not travel through sync, and a collection that is deleted and
   restored comes back unpinned.
4. Each group stays alphabetical until the user drags inside it, then keeps a
   custom order. New collections, newly pinned collections, and newly unpinned
   collections insert alphabetically while the target group is alphabetical,
   and append once it has custom order. Empty group labels are hidden. Unpinned
   is collapsible and the collapsed state is remembered per device. Collection
   rows carry no per-collection book count; the Unpinned group label shows how
   many collections it holds, so a collapsed group still conveys its size.
5. Sidebar selection uses the book-selection gestures: plain click replaces,
   Ctrl+click toggles, Shift+click ranges over visible rows and crosses the
   Pinned/Unpinned boundary. Modifiers on smart sections are ignored. Dragging
   uses a hover handle; dragging across the boundary pins or unpins. Pin,
   rename, delete, and drag act on the row they were invoked on, not the whole
   selection. Unpinning a selected collection keeps it selected.
6. Recently Added and Recently Read leave the sort control. Sort is always a
   concrete field, never a place-relative meta-option: the control offers Date
   added, Last read, Progress updated, Title, and Author. Each place has a
   default field: All Books and Recently Added use Date added; Recently Read and
   Reading history use Last read; In Progress and Finished use Progress updated;
   a collection uses Added to collection. That default is preselected until the
   user chooses another sort for the place, and choices are remembered per
   place, so the control always shows the order actually applied. Inside a
   collection place, the date sort uses the collection membership timestamp,
   labeled Added to collection; All Books uses the library added date, labeled
   Date added. In a multi-collection place, a book's Added to collection date is
   the earliest membership among the selected collections.
7. Collection rename is added, and delete asks for confirmation. A new
   collection is unpinned and the app navigates to it, replacing any
   multi-selection. Deleting the active collection removes it from the
   selection; if none remain, the place falls back to All Books.
8. The sidebar search becomes a command palette that finds books and
   collections. The library header search remains a view filter. The command
   palette groups results under Collections and Books. Collections come first,
   with exact or prefix collection-name matches sorted first inside the group
   and a cap of three; books take the remaining slots. Selecting a collection
   replaces the current place.
9. Book-to-collection drag is out of scope for this decision. Membership stays
   with the book context menu until a follow-up.

## Considered options

- **A header collection dropdown beside the sidebar list.** Rejected: both
  controls show the same inventory and set the same state. The dropdown is a
  second full picker with no unique job.
- **A pinned-only sidebar with the full dropdown for the long tail.** Rejected:
  it drops the Unpinned Collections group, splits collection selection across
  two surfaces, and makes the header the only place to reach an unpinned
  collection.
- **Collections as filters that compose with smart sections.** Rejected: the
  sidebar would carry two active dimensions, a collection restriction would
  follow the user into an unrelated section, and the UI would need a second
  active state to explain it. Format remains the composing filter per ADR 0012.
- **Synced pin state and order.** Rejected for now: pinning and ordering are
  arrangement preferences, not shared collection data. Syncing them would add
  schema, sync operations, and conflict handling for a local workspace concern.

## Consequences

- The library header loses its collection control; the sidebar becomes the only
  place to select collections. A long Unpinned group must stay navigable
  through collapse and the command palette.
- Pin state and order are local to a device. Two devices can show different
  sidebars for the same synced collections, and delete plus restore resets
  placement.
- Collection membership timestamps must be exposed to the frontend and
  preserved through sync projection so Added to collection remains meaningful.
  The membership table already stores `added_at`; the sync projection currently
  drops it.
- The sort control no longer uses Recently Added or Recently Read as labels.
  The sidebar keeps those names for the smart sections.
- The command palette becomes part of collection navigation, not only book
  search.
