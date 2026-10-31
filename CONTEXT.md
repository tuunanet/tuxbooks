# TuxBooks

TuxBooks is a local-first ebook library and reader for EPUB and PDF. This
context covers the vocabulary shared by the library, the readers, and the
document workers.

## Books and library

**Book**:
The durable unit a reader thinks of as one title. It owns reading progress,
annotations, collection membership, metadata overrides, last-opened, and
provider links, and it can exist with no file in the library.
_Avoid_: title, volume (for the durable record)

**Book file**:
A copy of a book at an absolute path. A book can have more than one file; a
file belongs to exactly one watched folder or single-file import.
_Avoid_: copy, edition (an edition is a different book identity)

**Catalog**:
The local index of book files and their source metadata. It is derived from
the watched folders and does not own user state.
_Avoid_: library (that term means current membership)

**Library membership**:
The state of a book having at least one file inside a watched folder. Import
creates it; Remove and Unwatch end it. It never owns reading progress or
annotations.
_Avoid_: loose book, library entry

**Unavailable book**:
A book whose file row still belongs to a watched folder but whose file is
missing. It stays in the library until the file returns or the user removes it.
_Avoid_: orphan, loose book

**Reading history**:
The view of books with no current library membership. It shows their durable
state and lets the user relink or forget them.
_Avoid_: archive, trash (the 30-day restore list is the trash)

**Reset reading data**:
Clearing a book's user state while keeping its identity and current file.
_Avoid_: delete book, clear library

**Forget book**:
Erasing a book's identity and user state. The current file, if any, is rebound
to a fresh identity; the old record stays restorable in the trash for 30 days.
_Avoid_: remove from library (that keeps the reading state)

**Relink**:
Attaching a file to an existing book. Reconnecting an unavailable file and
confirming a different edition as the same work are both relinks; only the
first keeps the same book identity automatically.
_Avoid_: reconnect (for a different edition)

**Edition link**:
A user-confirmed relation between two durable books that are different
editions of one work. The books stay separate identities: reading progress
copies as a percentage, the provider link and status move to the current
edition, and annotations stay with the original.
_Avoid_: merge, duplicate (an edition link is neither)

## Documents and engines

**Papers**:
GNOME's document viewer, formerly Evince. The reference point for TuxBooks' PDF
view behaviour.
_Avoid_: Evince (the earlier name)

**Engine**:
The component that turns document bytes into page rasters, page sizes, text
geometry, outline, and search results. EPUB-family formats share one and PDF has
its own; the format registry decides which one a book uses. The type is
`RenderEngine` in `frontend/src/lib/formats.ts`.
_Avoid_: backend, viewer, renderer

**Book format**:
What a book file is, decided from its extension at import: EPUB or PDF today.
Distinct from the engine that draws it (ADR 0012).
_Avoid_: file type, extension

**Format registry**:
The frontend table mapping each supported book format to its engine and display
label (`frontend/src/lib/formats.ts`). The library's format filter and the
reader's engine choice both read from it.
_Avoid_: format list, MIME table

**Format filter**:
The library header's multi-select filter over book formats. An empty selection
means every format, not no books.
_Avoid_: format tabs, file-type filter

**Engine seam**:
The boundary between the reader and its document engine. Reader code must not
depend on which engine is installed. Only the engine adapter crosses the seam.
_Avoid_: wrapper, abstraction layer

**Renderer**:
The Electron renderer process, where the reader UI runs. Not the document
engine.
_Avoid_: renderer (for the engine)

## PDF view

**View geometry**:
The layout and zoom mathematics that turn a document's page sizes and a zoom
state into page rectangles and scroll offsets. It is independent of the engine
and the UI framework.
_Avoid_: layout, zoom logic

**Reading anchor**:
The document point the reader holds across a position change: the viewport top
plus a quarter of the viewport height.
_Avoid_: scroll anchor

**Focal anchor**:
The document point under the pointer that a wheel or pinch zoom holds fixed. It
is held only on an axis that can scroll; an axis whose content fits the viewport
has no scroll range, so the page stays where the layout puts it.
_Avoid_: zoom center

**Keep-position**:
The scroll policy that preserves the reader's relative position through a
re-layout, as opposed to centering.
_Avoid_: preserve scroll

**Center on zoom**:
The scroll policy that holds a point fixed through an explicit zoom: the focal
anchor for a pointer zoom, the viewport center for a keyboard or toolbar step.

**Scale-and-swap**:
Holding a page's previous bitmap on screen, scaled to the new page box, while
its new-scale raster runs, then replacing it in one atomic blit. The visible
surface never blanks through a zoom commit.
_Avoid_: placeholder, stale raster

## PDF colour

**Color mode**:
The stored reader setting that decides how PDF pages are painted: default,
paper, dark, or invert.
_Avoid_: theme, dark mode

**Smart dark**:
The PDF reader's dark color mode, labeled "Smart dark" in the appearance menu. It
rasterizes each page through PDFium's category colour scheme, so path and text
colours are remapped while photographs keep their pixels.
_Avoid_: dark mode

**Color scheme**:
PDFium's category-level recoloring: path fill and stroke, text fill and stroke.
The mechanism behind the Smart dark mode, coarser than object-level recoloring.

## Data and storage

**App data**:
Everything TuxBooks stores to run: the catalog database, the cover cache, the
GPU fallback marker, and the browser caches and settings in the Electron config
directory. It never includes the user's book files.
_Avoid_: the library (that term means the books currently in the watch list)

**Cache**:
The subset of app data the app regenerates by itself: the Chromium browser caches
and the GPU fallback marker. The catalog, the cover cache, and the settings sit
outside it.
_Avoid_: app data, temporary files

**Watched folder**:
A directory the user added for TuxBooks to watch — by importing the folder
itself or any single file inside it. TuxBooks imports the books inside it
and keeps them in sync as files change.
_Avoid_: library location, book folder

**Unwatch**:
Removing a watched folder from the watch list. Its files stay on disk and its
books leave the library; their reading history is kept and reappears if the
files return. Only folders that are not inside another watched folder are ever
listed, so every one of them can be unwatched on its own.
_Avoid_: remove folder, stop tracking, delete books

**Sync folder**:
The user-chosen folder a cloud client already mirrors. TuxBooks writes only
inside its `TuxBooks` child and never calls the provider's API. See
[SYNC.md](docs/SYNC.md).
_Avoid_: cloud drive, remote, backup folder

**User state**:
The durable state a book owns: reading progress, annotations, metadata
overrides, collections and membership, last-opened, and provider links. Local
disappearance never deletes it.
_Avoid_: catalog data, file metadata

**Shared state**:
The subset of user state that travels between machines through a sync folder:
reading progress, annotations, metadata overrides, collections and membership,
last-opened, and cover-override blobs. The catalog, paths, and watched
locations are not shared.
_Avoid_: synced database, cloud library

**Device**:
One TuxBooks installation with a random id and a human name. Device streams are
kept apart in the sync folder; the name is display only.
_Avoid_: machine, client

**Book identity**:
The stable uuid for a book, assigned locally at import and linked to SHA-256
content-hash aliases, so a rewritten file keeps its identity and two
independently imported copies converge.
_Avoid_: content hash (that is only the discovery key), ISBN key

**Provider link**:
The record that one durable book is also tracked on a third-party reading
service, keyed by book identity and holding the remote id and last known
provider status. It survives the book leaving the library; see
[PROVIDERS.md](docs/PROVIDERS.md).
_Avoid_: account link (a link belongs to a book), sync binding

**Tombstone**:
A shared delete marker for an annotation or collection. It wins over a
concurrent edit and stays restorable from the trash for 30 days.
_Avoid_: deleted row, hard delete

**Sync issue**:
A failure or condition the sync subsystem records with one primary action, such
as Retry, Open folder, or Copy details. It clears when the condition clears;
only an informational row can be dismissed. See
[ADR 0015](docs/adr/0015-sync-recovery.md).
_Avoid_: sync error, warning dialog

**Conflict review**:
The Settings > Sync queue of values a merge discarded. The current winner stays
applied, the losing value is kept until resolution or 30-day expiry, and
resolving one publishes a normal synced operation so every device converges.
_Avoid_: conflict modal, merge prompt

**Sync attention**:
The Settings entry dot and the transition toast that show sync needs review
outside Settings. They appear only while sync is on and a condition is open.
_Avoid_: sync badge, warning banner

## Search

**In-book search**:
A query over the text of the open book, returning matches in document order
with a location and a surrounding excerpt.
_Avoid_: find, full-text search (that term belongs to the library catalog)

**Search overlay**:
The transient search surface over the reader: a query field and a result list
that jumps to the picked match. It is not a navigation drawer tab.
_Avoid_: Spotlight (the Apple feature it borrows its interaction from), search dialog

## Verification

**Fidelity oracle**:
A native GNOME Papers build used as the authority for what correct view geometry
is. Tests compare the reimplemented geometry against it.
_Avoid_: reference implementation
