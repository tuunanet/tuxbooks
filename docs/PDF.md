# PDF layer

`sidecar/src/pdf/` is a metadata-only PDF reader built on `lopdf` (pure
Rust, no rendering engine). Like `epub/`, it has no runtime (Tauri/Electron)
or SQLx imports and returns owned data. The stated reason for the
dependency: the scanner must index real-world PDF libraries
(title/author/subject) without pulling in a renderer — page rendering
belongs to the frontend engine (see "Rendering" below).

## Public API

```rust
pub fn parse_pdf(path: &Path) -> Result<PdfBook, PdfError>;
pub fn read_file_properties(path: &Path) -> Result<Vec<(String, String)>, PdfError>;

pub struct PdfBook {
    pub metadata: PdfMetadata,
}

pub struct PdfMetadata {
    pub title: String,              // /Title, or file-name fallback
    pub author: Option<String>,     // /Author
    pub description: Option<String> // /Subject (PDFs have no description field)
}
```

## Behavior

1. **Open** — `lopdf::Document::load`; structural failures (not a PDF,
   unrecoverable xref, unsupported encryption) are `PdfError::Parse`.
2. **Info dictionary** — resolved through the trailer (`/Info` may be an
   indirect reference). A missing Info dictionary is not an error.
3. **Strings** — UTF-16BE (with `FE FF` byte-order mark) and
   PDFDocEncoding/Latin-1 are both decoded, trimmed, never lossy-panicking.
4. **Title fallback** — a missing/empty `/Title` indexes the book under a
   humanized file name (underscores become spaces); titles are mandatory in
   the library schema.

## File properties (read-only)

`read_file_properties(path)` returns every non-empty document information
dictionary entry in a stable order — Title, Author, Subject, Keywords,
Creator, Producer, Creation date, Modification date — for the book detail
view's "Original File Metadata" panel. Unlike `parse_pdf` there is no
file-name title fallback: the panel reports what the file actually carries.
PDF date strings (`D:YYYYMMDD…`) are rendered as `YYYY-MM-DD HH:mm`.

## Import mapping

| PDF field  | Library column                                                     |
| ---------- | ------------------------------------------------------------------ |
| `/Title`   | `title` (file-name fallback)                                       |
| `/Author`  | `author`                                                           |
| `/Subject` | `description`                                                      |
| —          | `publisher`, `language`, `isbn` stay NULL                          |
| page 1     | `cover_path` (rasterized to PNG by `pdf/render.rs` at import; NULL |
|            | when the PDFium library is unavailable — placeholder art then)     |

Cover rasterization stays in Rust (PDFium). Decision recorded at migration
phase 4: MuPDF in the renderer does not replace it — renderer MuPDF
rasterizes whole documents for the reading surface, while import-time
covers need a per-file, no-UI rasterization in the sidecar; keeping PDFium
avoids loading every full document during a scan for identical quality.

## Metadata writing (embed)

`write_metadata(path, &PdfMetadata)` supports the metadata dialog's explicit
"Embed into file" action: it sets `/Title`, `/Author`, and `/Subject` in the
document information dictionary (creating one when absent and preserving every
other Info entry), saves through `lopdf`, and swaps the file atomically.
Non-ASCII values are written as UTF-16BE hex strings with a byte-order mark —
the same forms the reader decodes. Publisher, language, ISBN, publication
date, series, and subtitle have no faithful PDF Info field and stay
database-side as overrides (the embed flow reports them as still overridden).
Library subjects are not written to `/Keywords` — that mapping is a deliberate
follow-up, so `/Keywords` stays a read-only file property for now. A one-time
`<file>.bak` copy of the original is made before the first write
(later embeds keep it), so the pre-embed file is always recoverable.

## Error handling

Per-file failures never abort an import run: the importer collects them in
`ImportReport.failed` exactly like EPUB parse failures.

## Rendering

Rendering is the renderer's job: **MuPDF.js/WASM** (`mupdf` npm package)
rasterizes pages, with all engine objects and rasterization in a dedicated
module worker (`lib/pdf/mupdfWorker.ts`) — MuPDF renders synchronously, so
the worker keeps it off the UI thread. One worker instance serves one
document; closing the document terminates the worker and frees the whole
WASM heap. The WASM bundle is emitted by a small Vite plugin
(`virtual:mupdf-wasm-url` in `vite.config.ts`) because the emscripten
glue's own chunk-relative resolution never finds the asset in a bundled
build; the main thread resolves the URL and passes it into the open
request, where the worker pins it as `Module.locateFile` before the
dynamic engine import. `frontend/src/lib/pdf/pdfEngine.ts` is the only
module that touches MuPDF. Byte access flows through the `tuxbooks://`
custom protocol (range requests supported) — paths never cross the
boundary.

### Opening (range-backed, never whole-file)

Documents open through the engine's **random-access stream**
(`openPdfDocumentFromBook`): the worker wraps `tuxbooks://book/<id>` in a
`mupdf.Stream` handle whose reads are synchronous XHR **HTTP Range
requests** (legal only inside a worker) against the Electron protocol
handler, which seeks/reads through the Rust sidecar. MuPDF therefore pulls
only the ranges it needs — the xref trail first, page 1 content next — and
the first readable page no longer waits for the whole file to cross the
bridge. A 1 MiB read-ahead chunk cache (bounded, LRU) keeps MuPDF's
scattered object reads from becoming one request per object. The in-memory
`openPdfDocument(bytes)` path remains for tests and byte sources that are
already fully resident.

### Engine prewarm

`prewarmPdfEngine()` loads the MuPDF module into a spare worker (no
document, no rasterization) once the app shell has rendered and the main
thread is idle (`AppShell`'s `PdfEnginePrewarm`); the first open adopts
that warm worker instead of paying worker startup + WASM fetch/compile on
the critical path. It is single-flight, disabled without a Worker
environment, and a failed prewarm only means the next open starts cold.

### Continuous reader architecture (`frontend/src/components/reader/pdf/`)

- `PdfReader.tsx` — composition root: zoom state, the initialization
  sequence (document ready → layout ready → position restored →
  interactive), and the render-set derivation.
- `hooks/usePdfDocument` — opens the book through the range-backed engine
  seam (`openPdfDocumentFromBook`); owns the document lifetime (destroy on
  unmount/book switch). A switch also drops
  the previous document from state in that render (render-phase reset), so
  a closed document never serves a render while the next loads, and a load
  that lands after its book was superseded is destroyed, never mounted.
  Records the open-timeline anchor + `open=` segment for the telemetry
  attributes below.
- `hooks/usePdfGeometry` — reserves the whole document from a page-1
  estimate, then corrects pages lazily as they approach visibility
  (`measurePages`; corrections are idempotent per document).
- `hooks/usePdfVirtualization` — an IntersectionObserver pair over the slot
  elements (visible: no margin; preload: a fixed ±1200 px ≈ one 1080p
  viewport, bounded at any window size) feeds the visible/preload page sets.
- `hooks/usePdfScrollTracking` — rAF-coalesced scroll sampling. Current
  page = the page containing the reading anchor (viewport top + 25% of the
  viewport height); also records the anchor's in-page fraction.
- `hooks/usePdfScale` — layout scale from the zoom state (issue #65): the
  fit modes recompute continuously from the measured content area and the
  shell's scroll container (ResizeObserver pair + window resize), custom
  mode is a fixed ladder level. Pure scale selection lives in
  `pdfLayout.computePdfScale`; unmeasurable dimensions fall back to 1.
- shared `components/reader/useReaderProgress` — debounced save +
  restore-once (below); one persistence core for both formats, with PDF
  page validation in `readerModel.parsePdfProgress`.
- `pdfLayout.ts` — pure layout math (slot stacking, page lookup at an
  offset, clamping, scroll compensation, fit-width scale, thumbnail
  geometry); unit-tested without a browser.
- `pdfRenderPolicy.ts` — pure render-budget math: the effective render
  ratio per page (devicePixelRatio capped by the backing-store budgets, CSS
  upscales beyond) and the byte cap over the live render window.
- `pdfOutline.ts` — pure outline normalization: the engine's raw outline
  resolves to a tree of `{ title, page (1-based | null), items }`;
  unresolvable entries degrade to inert rows, never errors. Re-exported
  through the engine seam so components never touch the engine's raw types.
- `PdfDocumentView` / `PdfPageSlot` / `PdfPageCanvas` — one geometry slot
  per page for the entire document; canvases only for the bounded render
  set. Slots carry `data-pdf-slot` + `data-render-state` lifecycle
  attributes (`unloaded|queued|loading|rendering|rendered|error`) for tests
  and diagnostics.
- `PdfToolbar` — the document controls (page navigation `‹ Page X of Y ›`;
  the zoom cluster `− % +` whose indicator doubles as the Ctrl+0 reset; the
  fit page/width/height toggles with `aria-pressed` state; the
  presentation-mode toggle — issue #65), docked through a portal into a
  header slot owned by ReaderShell — the same pattern as PdfSidebar, with
  an inline fallback when no host is provided (standalone renders, e.g.
  unit tests). Native `title` tooltips instead of Radix Tooltip: the
  toolbar also renders standalone, where no TooltipProvider exists. No
  control row renders above the document, so its vertical space goes to
  the pages; the reader keeps owning the zoom and position state.
- `PdfPresentationBar` — the floating in-presentation controls (prev/next,
  page indicator, exit), fixed to the bottom edge of the document while
  the shell's chrome is hidden (issue #65).
- `PdfSidebar` — the thumbnails panel (below). Rendered through a React
  portal into a host `<aside>` owned by ReaderShell's layout.

### Zoom modes (issue #65)

The zoom state is `{ mode, level }` — never a bare multiplier:

- **Fit width** (default; Ctrl+2) — document-wide scale from the page-1
  reference vs. the content area. Wider pages in mixed documents overflow
  horizontally instead of shrinking the fit reference.
- **Fit page** (Ctrl+1) — the binding axis wins (min of fit width/height).
- **Fit height** (Ctrl+3) — viewport height vs. the page-1 reference
  height.
- **Custom** — a fixed rung on `ZOOM_LADDER` (25–400%; 1 = 100%). Ctrl+0
  resets to 100%. `Ctrl`+`+`/`-` (also bare `+`/`=`/`-`) snap the current
  effective scale onto the nearest rung and step from there, so leaving a
  fit mode continues from where the page actually is.

The fit modes are dynamic: the scale is recomputed from the measured
viewport whenever it changes (window resize, sidebar toggle), and the
indicator shows the effective page zoom (`scale × 100`). Any zoom or
mode change invalidates rendered canvases and the scale-keyed bitmap
cache. `Ctrl` + mouse wheel zooms (trackpad pinch arrives as the same
ctrl-modified wheel in Chromium): the deltas accumulate onto ladder steps
(`WHEEL_STEP_PX`, 40). The toolbar's zoom indicator doubles as the reset
control. A scale change alone re-anchors by the reading anchor's in-page
fraction; a page change from navigation lands on the new page's top edge.

### Presentation mode (issue #65)

Ctrl+L (shell-owned toggle, shared with the EPUB mode — issue #64; also the
toolbar's Presentation button) turns the PDF reader into a fullscreen,
distraction-free one-page view:

- The shell hides the normal chrome (header, progress footer, thumbnails
  sidebar), requests fullscreen best-effort (a denied request still gives
  the layout inside the normal window), and exits the mode on `Esc` and on
  a native fullscreen exit (`fullscreenchange`). The mode never outlives
  the open book.
- The reader switches to a **dynamic fit-height mode keyed to the page
  being read**: the scale is recomputed per page from its real dimensions,
  so mixed-size documents rescale as you flip (the whole document relayouts
  at the current page's scale). Entering preserves the current page and
  position; leaving restores the pre-presentation zoom state exactly.
- Page navigation lands on the page's top edge, so `PageDown`/`Space`/
  `PageUp`/`Shift+Space`/arrows (page-based shell steps, not percentage
  stepping — rounding error would map midpoints back onto the previous
  page) flip whole pages without touching zoom controls. The floating
  `PdfPresentationBar` mirrors prev/next/indicator and adds the exit
  control.

Shift participates in shortcut combos (`shift+space` vs `space`), so
selection-extension keys and Shift+Space never alias the unmodified
navigation combos.

### Virtualization and rendering policy

Never render a large PDF into the DOM at once; keep rasterization off the
critical path.

1. Up to `MAX_CONCURRENT_RENDERS` (2) renders run at a time; completions
   and cancellations free their slot for the next priority page. The
   reading anchor starts first, then visible pages (closest first).
2. Exactly one prerender page beyond the viewport — and only while the
   concurrency budget has room to spare.
3. A superseded render is unmounted (cancelled); it never starts or blits.
4. Completed canvases stay mounted while their page stays inside the
   virtualization window, bounded first by a byte budget
   (256 MB, `MAX_ACTIVE_CANVAS_BYTES`) and then by the count fallback
   (`MAX_ACTIVE_CANVASES`, 8): at 4K only the closest few page-sized
   buffers fit, at smaller windows the byte budget is inert. Distant pages
   keep geometry-only slots and report `data-render-state="unloaded"`. The
   rendered/failed page sets reset with the document, so a switched book
   can never inherit the previous book's render marks.
5. Each page rasterizes into an offscreen buffer at the effective render
   ratio (`pdfRenderPolicy.effectiveRenderRatio`), a two-tier ladder:
   devicePixelRatio preferred, degrading to the soft budget, then to CSS
   resolution (never blurrier than the layout while the hard budget
   allows), and only under zoom into the hard per-dimension budget; the
   canvas CSS size stays at the displayed size and CSS upscales beyond the
   ratio. While the very first page of a freshly opened document is
   pending, the anchor page renders **two-stage** (`preview`): a readable
   preview at ratio ≤ 1 blits first and the full-ratio refinement replaces
   it in the background — the visible canvas only ever receives complete
   bitmaps (canvas carries `data-pdf-render-quality`
   `preview|final`).
6. On eviction the finished bitmap moves into a per-document LRU cache
   (`pdfBitmapCache`, bounded by a 320 MB byte budget and entry count,
   keyed by render scale and effective ratio, dropped on zoom and on
   document switch). A page that re-enters the window blits its retained
   bitmap in one synchronous draw — scrolling back across a heavy page
   never re-pays the raster. Cache occupancy is exposed for diagnostics as
   `data-pdf-bitmap-cache` (`entries:bytes`) on the reader element.

Every render paints into a private offscreen buffer; the visible canvas is
touched only by the atomic blit of a completed render (single-writer —
interleaved paint on shared canvas state produced mirrored page fragments
under fast scrollbar drags). Page render failures show a per-slot error
with Retry; a page failure never breaks the document.

This pipeline is budgeted in pixels and bytes (canvas caps, cache
occupancy, live-canvas memory) — the contracts and their verification live
in `docs/PERFORMANCE.md`. Check them before changing rendering,
virtualization, or cache policy. Startup diagnostics (PERF-11) are
deterministic attributes on the reader element (`data-pdf-render-info`:
dpr, content width, viewport height, fit scale; `data-pdf-render-ms` on
each canvas: the last render→blit durations).

### Open-timeline telemetry (state, not timing)

The reader publishes the PDF-open path as deterministic attributes on
every reader surface (error/loading/interactive), driven by the pure
helpers in `pdfOpenTelemetry.ts`:

- `data-pdf-open-state` —
  `created|document-opening|document-ready|geometry-ready|first-render-start|interactive`
  (a failed open reports `created` + the error surface);
- `data-pdf-open-timing` —
  `bytes=range;open=…;firstPaint=…;interactive=…`, segments omitted until
  measured (`open` = click→document parsed, `firstPaint` = click→first
  rendered page, `interactive` = the later of first paint and position
  restore);
- `data-pdf-open-ms`, `data-pdf-first-paint-ms`, `data-pdf-first-page` —
  the individual segments as bare numbers/page.

E2E asserts state values and attribute shape only; timing thresholds are
manual-bench material (`just bench-reader`, docs/PERFORMANCE.md), never
headless CI assertions. Outline work is explicitly ordered below first
paint: the outline request is sent only after the first page has rendered,
so it can never occupy the MuPDF worker ahead of page 1.

### Thumbnails sidebar (`PdfSidebar`)

The same virtualization policy at low resolution. The sidebar reuses the
slot/observer pattern: one cell per page reserves space up front (aspect
from the shared page sizes, corrected lazily via the same `measurePages`
path), and an observer pair feeds a render set capped at
`MAX_THUMBNAIL_CANVASES` (12) with exactly one render in flight — unbounded
thumbnail requests would starve the page the user is looking at. Canvases
render at the cell width (`THUMBNAIL_WIDTH_PX`, 112), mount only inside the
window, and evict with it, so memory stays bounded on any document. The
reading page's cell is marked (`data-thumb-active` / `aria-current`) and
follows the position whether it moves by scrolling, navigation, or restore;
clicking a cell navigates the reader (and suppresses the one follow-up
auto-scroll). Failed thumbnails flag their cell and re-attempt when the
cell re-enters the window — no per-cell retry buttons.

### Outline

The document outline comes from the engine seam (`getPdfOutline`) — the
MuPDF document is already parsed in the renderer, so the outline shares the
engine with rendering instead of growing a second parser in Rust. Every
destination resolves to the same 1-based page locator the reader persists;
PdfReader reports the normalized tree upward and ReaderNavigation's Outline
tab renders it with depth indentation. Outline navigation reuses
`pageToPosition`, so jumping lands in the same position model as scrolling,
thumbnails, and restore.

### Reading position persistence

`save_reading_progress` / `get_reading_progress` methods store
`reading_progress` rows (migration `0003` added `page_number` and
`scroll_offset`). For PDFs the page number is the stable position;
`progress_percent` feeds the shell footer. The reader restores exactly once
after the layout is ready — invalid values degrade to page 1 — saves are
debounced (1s) so scrolling never writes per event, the first armed run is
skipped so opening a book writes nothing, and unmount flushes the final
position. Every persisted save (including `mark_book_finished`) emits
`library-changed` with the updated book, so the grid and list progress
bars stay live without an app restart. The document surface renders only
after restoration, so reopening
never flashes page 1 before the jump. This contract lives in one shared
hook (`useReaderProgress`) used by both readers; the PDF reader also
registers the shell's `ReaderAdapter` (`readerModel.ts`) while its document
is loaded — `jump` maps page targets through the same `pageToPosition`
model as scrolling, thumbnails, outline, and restore — and reports
`{ format: "pdf", page, fraction }` positions upward for bookmark
placement.

### In-book search

Search reuses the engine that already renders the document instead of
growing a second extraction architecture: the seam pulls a page's text
content through MuPDF and assembles it with the pure helpers in
`lib/pdf/pdfSearch.ts` (item and line boundaries become single spaces, so
queries match across them like they read on the page).

`components/reader/pdf/hooks/usePdfSearch.ts` walks pages sequentially
(worker-serialized), matches case-insensitively, streams one group per page
with matches up to the shell, and stops at 500 total matches so a
pathological document cannot flood the drawer. Each page's text is cached
for the document's lifetime (dropped on document switch), so refining a
query re-searches without re-parsing; a generation token makes a new query
supersede the running one.

The drawer's Search tab is the shared `ReaderSearchTab`; PDF matches carry
`page` (EPUB matches carry a locator — see `searchModel.ts`). Picking a
match navigates with the same `pageToPosition` model as scrolling,
thumbnails, outline, and restore.

### Text layer, selection, and highlights

Rendered pages mount a text layer (`PdfPageTextLayer`, through the seam)
over the canvas: transparent, selectable text spans — the interaction
affordance for highlights, no visuals of its own. The seam builds the spans
from MuPDF structured-text lines; its stylesheet (`lib/pdf/pdfTextLayer.css`)
is coupled to that geometry and is reviewed when MuPDF changes. Text layers
exist only on the bounded render set, like canvases.

Text selections are captured on `pointerup` (deferred one tick): the
anchor node resolves the page through the slot's `data-pdf-slot`, the
selected text and the range's client rects normalize to page space
(`normalizeRect`, clamped to 0..1 so the backend's geometry validation
accepts sub-pixel bleed), and the whole candidate — page, text, rects — is
stored at capture time. This matters: clicking the selection toolbar's
color swatch collapses the native selection before the click handler runs,
so creation must not re-read the live selection (the reader's `pointerup`
capture also ignores events originating inside the toolbar). The upward
report carries the existing highlight the selection targets, if any: the
same-page highlight with the largest rect overlap
(`highlightForSelection`), or the highlight under a plain click
(`highlightAtPoint`).

Persisted highlights render through `PdfHighlightOverlay`: absolutely
positioned translucent rects in normalized page space, so they track the
canvas at every zoom without recomputation, drawn for the open book's
annotation list (grouped by page in PdfReader, rendered inside the page
wrapper). The overlay stays pointer-transparent: a plain click resolves
through the selection handler instead of overlay events.

Existing highlights are edited from the same selection toolbar. When the
reported target has a highlight, the toolbar switches from creating to
editing — color swatches recolor the annotation (`update_annotation`), and
a distinct Remove action deletes it (`delete_annotation`, the same path as
the navigation drawer). Removal is a real deletion, never a transparent
recolor — a dead annotation would linger in state, search, and the
drawer. Bookmarks persist the anchor page + in-page fraction reported by
the scroll tracker — a coarse page-local position, per the data model.

### Worker

The MuPDF worker is bundled and configured once in the engine. A
main-thread fallback is the classic cause of seconds-long variable renders
— the reader exposes `data-pdf-worker-src` and the seeded E2E verifies the
asset is fetchable. One worker serves one document, so render, text
extraction, outline, and thumbnail requests serialize inside it; the
open-path ordering (page 1 first, then adjacent pages, then outline and
thumbnails) is enforced on the main thread — see "Open-timeline
telemetry" above.

### Diagnostics

The worker posts an out-of-band breadcrumb for every request it starts,
finishes, or fails (`{ kind: "pdf-worker-diag", … }`, no request id) that
carries the method, page, elapsed time, and the current MuPDF WASM heap
size; the engine logs the stream at debug level and keeps the last line.
A worker request in flight past `WORKER_STALL_WARN_MS` (10 s) is reported
by a main-thread watchdog while it is still running, so a blocked worker
(Smart Dark OOM, a synchronous range read) leaves a trace instead of
looking like a frozen UI. The main process mirrors the renderer console
and replays its tail on `render-process-gone` (`electron/main/index.ts`),
because a renderer crash takes the whole console with it. The heap line is
the leak signal: it must stay flat across repeated renders of one
document.

### Appearance and color modes (issue #67)

PDFs are fixed-layout rasters: the reader's reflow controls (font size,
spacing, family, alignment, columns, layout, margins) apply only to EPUB
and are not displayed for PDFs — the appearance menu offers exactly the
theme, which for PDFs is really a set of **color modes**
(`lib/pdf/theme.ts`, driven by the same stored reader theme as EPUB):

- **Default / Light** — pages render as-is.
- **Paper** — multiply-tints the white pages to the theme's own paper color
  (a CSS filter cannot darken white).
- **Dark = Smart Dark** — object-aware recoloring _inside the MuPDF worker,
  before rasterization_: the page runs through a callback `Device`
  (`makeSmartRecolorDevice` in `mupdfWorker.ts`) that forwards every drawing
  operation to a `DrawDevice` while remapping fill/stroke/text/image-mask
  paint colors onto the dark palette (`lib/pdf/smartColors.ts`). Black maps
  to the light text color, white to the dark background, grays ramp by
  luminance; chromatic colors keep their hue with a compressed lightness so
  links and accent fills stay recognizable. Ordinary `fillImage` operations
  pass through unchanged — photographs, covers, and screenshots are never
  turned into negatives. Pages without an explicit background fill are
  pre-filled with the dark background (PDFs do not paint their own page
  background; viewers supply the white). Image-mask paints follow the
  text rules (masks are stencil shapes, not photos).

  The callback device is the one place the reader touches the engine's JS
  device binding, and that binding keeps a native reference per argument it
  passes (path, colorspace, text, stroke, image) expecting JavaScript GC to
  drop it. In a worker the GC never keeps up, so the Smart Dark path must
  release each argument right after forwarding it and destroy the device,
  its `DrawDevice`, and the background path per render
  (`releaseDeviceArgs`); `Shade` is the exception (a borrowed pointer) and
  must not be dropped. Without this the WASM heap grows on every render
  until the renderer dies (see "Diagnostics" for the heap breadcrumb that
  catches it).

- **Invert** — the explicit full-page negative (`invert(1)
hue-rotate(180deg)`, the recipe Foliate popularized), kept from the old
  Dark behavior for users who actually want inversion. A CSS filter over
  the document surface, like High contrast (`grayscale + invert +
contrast`).

The recolor-only EPUB presets (Blue, Mint) have no faithful raster
treatment and remain EPUB-only. "Invert" is a PDF-only stored theme name
(`ReaderTheme` in `lib/epub/appearance.ts`); consumers with EPUB semantics
normalize it to the dark preset via `epubSurfaceTheme` so a pick made on a
PDF never reaches EPUB engines or shell chrome as an unknown name.

#### Scanned and rasterized pages

A page that _is_ one large image cannot be recolored object-by-object, and
leaving it bright would break dark reading. When a raster image covers
most of the page (≥ 60% coverage), the worker samples its decoded pixels
and classifies it (`classifyRasterImage`): paper-backed, achromatic
rasters (scans, rasterized text pages) are transformed with the same
palette mapping as vector content; anything with meaningful chromatic
content keeps its colors. The chromatic-fraction signal exists because
the mean saturation cannot tell covers from scans: on a white-dominant
page (the AI Engineering cover measures 69% near-white, mean spread
0.027, 2.7% clearly chromatic pixels) the background dilutes the mean
into indistinguishability, while the chromatic accents (logo, colored
artwork) always mark designed artwork. Classification decisions are
cached per document/page/image-ordinal, and the transformed image in a
small LRU, so re-renders never re-pay the analysis. The original image's
decoded pixmap is only ever read — the transform runs on a private
DeviceRGB copy (`convertToColorSpace`), since the decode result is owned
by MuPDF's per-image cache.

Color mode is part of the render and cache identity: the worker render
request carries the palette only in Smart Dark, and the per-document
bitmap cache (`pdfBitmapCache`) keys entries by `{page, scale, ratio,
variant}` where `variant` is `"original" | "smart"` — a mode switch
re-renders instead of serving the other mode's pixels. The shell chrome
around the surface follows the same theme in both formats.
