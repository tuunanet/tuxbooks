# Scaling bulk imports: Foliate, Thorium, and TuxBooks

Research behind issue #61 (bulk import of ~11k books freezes/crashes the
app). Question: how do established readers handle large libraries —
Foliate (`johnfactotum/foliate`, GTK4) and Thorium Reader
(`edrlab/thorium-reader`, Electron/React — our direct architectural
analog) — and what is TuxBooks doing that it shouldn't? Sources: both
apps' actual source (Foliate at HEAD `67b6676`, Thorium via
`readium/readium-desktop`), the Foliate #1623 issue, and a code audit of
our sidecar and renderer. Findings below are pinned to file:line so each
can become a work item.

## TL;DR

Foliate never faces our problem because it **has no bulk import at all** —
books enter its library one at a time, when opened, and the library is just
a list of already-extracted tiny JSON files. Thorium shares our stack
(Electron + React) and _also_ has no folder scan — imports are explicit
user file picks — and it keeps display cost flat by **paginating the
library grid to ~50 cards per page**. What transfers to TuxBooks is
display-side design: **render only a window of the library** (virtualized,
incremental, or paginated — any of the three), **batch event
updates**, and **lazy cover IO**. TuxBooks' freeze is not one bug but a
stack of them:

1. **Sidecar parses everything before doing anything** — `scan_directory`
   buffers ~11k fully parsed books in RAM, and no event fires until the last
   one is parsed.
2. **Sequential pipeline** — one book at a time, CPU-heavy parsing and
   PDFium rasterization inline on the async runtime, five-plus DB round
   trips per book.
3. **Event flood** — one IPC event per book, none coalesced.
4. **Renderer does O(n log n) work per event** — full array copy + full
   re-sort per received book, ~11k React commits.
5. **No virtualization** — all 11k cards (and 11k cover fetches) are in the
   DOM at once.

## How Foliate actually works

### It sidesteps bulk import by design

Books enter Foliate's library **when they are opened in the reader**, not
via a scan. Opening a book extracts metadata + cover exactly once and
persists two small artifacts: a per-book JSON sidecar file and a
fixed-width cover PNG (`src/data.js` — `saveCover`, `saveURI`; cover is
scaled to a 256px `GdkPixbuf` before saving). The "library" is a directory
listing of those JSONs (`src/library.js:105`, `listBooks` — a generator
over `*.json` files). Metadata extraction cost is paid once per book at
open time, where the user is already waiting on that one book — never as an
N-book synchronous batch. Folder/multi-book import remains an open feature
request (issue #1623); the import dialog that exists is for annotations
only.

**Caveat for the comparison:** this means Foliate is not evidence that
"bulk parse of 11k real EPUB/PDF files can be fast". TuxBooks must parse
every file at least once — that cost is real. What Foliate proves is that
the **library display and index layers** can be made O(visible) instead of
O(n), and that's where our freeze mostly lives anyway.

### Its display layer only materializes what is visible

- **Incremental population.** `BookList` keeps a lazily-consumed iterator
  over the JSON files (mtime-sorted) and appends in fixed batches:
  `loadMore(n)` (`src/library.js:157`). The scroll handler
  (`#checkAdjustment`, `src/library.js:356`) requests another batch only
  when the viewport nears the end, retrying every 10ms while filling.
  Nothing beyond the first screenful exists at startup.
- **Widget virtualization.** The grid is a GTK4 `GridView` with a
  `SignalListItemFactory` (`showGrid`, `src/library.js:372`); GTK realizes
  and recycles only visible rows. An 11k-item model costs 11k model
  entries — not 11k widget trees.
- **Lazy, memoized IO.** Metadata and covers are read at bind time (i.e.,
  only for visible items) and cached:
  `readFile = memoize(readJSONFile)`, `readCover = memoize(pixbuf from
cached PNG)` (`src/library.js:150-155`). A card's cover promise resolves
  asynchronously into the already-realized item (`bind` handler).
- **Fixed-size covers.** Covers are normalized to one width on extraction,
  so decode/texture cost per card is bounded (`saveCover`, `src/data.js:83`).

## Thorium Reader: the Electron/React analog

Thorium (`edrlab/thorium-reader`, canonical repo `readium/readium-desktop`)
matters more to us than Foliate because it is the same architecture:
Electron main + React/Redux renderer, custom-protocol-served assets,
metadata parsed from EPUBs at import. Two structural facts:

### Also no bulk scan — but it parses in the _main process_, in JS

Publications are added through an explicit file-pick dialog
(`FileImport.tsx`), one action per user gesture; the main process copies the
file into its managed bookshelf and parses metadata with Readium's
TypeScript toolkit (`@r2-shared-js` imports across `common/`). Like
Foliate: **metadata extraction happens once, per explicitly added file** —
there is no directory walk, no re-parse of the library, no watcher. The
bookshelf is the copy. (TuxBooks references files in place — a deliberate
product difference worth keeping — but it means our re-scan/reconcile path
must lean on stat caching, see P1 below.)

And a reality check: Thorium's per-book parser is JavaScript in the
Electron main process — _slower per book than our Rust sidecar_ — yet its
library doesn't freeze, because it never renders an unbounded list and
never re-parses what it already extracted. The display layer, not parse
speed, is what keeps it usable.

### Display cost is flat: pagination, not virtualization

The "All publications" view is a `react-table` with `usePagination`
(`src/renderer/library/components/searchResult/AllPublicationPage.tsx`):
`PAGESIZE = 50` (`:2245`), with a resize effect that pads the page size to
fill the grid row exactly (`:2388-2395`). The user pages through 11k books
with first/prev/next/last controls; **at most ~50 `PublicationCard`s exist
in the DOM at any moment**. Search/filter/sort run over the in-memory
table data with `matchSorter` and debounced inputs (`useAsyncDebounce`,
`debounce` imports at `:67`, `:112`) — the model may be big, the render is
not.

Trade-offs worth noting honestly: pagination is simpler and more
accessible than virtualization (plain buttons, real scrollbars, no
windowing library), and it plays fine with roving-tabindex keyboard nav
because the rendered set is small. What it costs: the _whole_ model still
lives in renderer memory (Thorium hydrates its Redux state at startup), so
at very large n the sort/filter work happens per interaction over all n —
fine for tens of thousands; beyond that, push filter/sort/page into
SQLite/FTS5 (which we already have) and fetch only the current window.
Pagination-vs-windowing is a choice of implementation effort, not a
disagreement about the goal: never render unbounded lists.

## Where TuxBooks falls over

### Sidecar: parse-everything-then-import

`scan_directory` (`sidecar/src/services/library_scanner.rs:96`) walks the
tree and **parses every book inline during the walk**, collecting all
results:

```rust
let mut entries: Vec<ScannedEntry> = WalkDir::new(root)
    ...
    .map(|entry| {
        let path = entry.into_path();
        let book = parse_book(&path);   // full zip+XML / PDF parse, inline
        ScannedEntry { path, book }
    })
    .collect();                          // ALL of them, before returning
```

Consequences at 11k books:

- **Peak memory holds every parsed book simultaneously.** `ScannedBook` wraps
  the full `EpubBook` (metadata + manifest + spine + item maps, boxed) /
  `PdfBook`. Linear in library size; this is the "memory explodes" suspect
  confirmed.
- **Zero feedback during the entire parse phase.** `import-progress` events
  only start after `scan_directory` returns — i.e., after the _last_ file is
  parsed. The user watches a frozen-looking app for the whole CPU-bound
  walk.
- The sorting for determinism (`entries.sort_by`) then has to move 11k
  boxed books around — cosmetic, but symptomatic.

### Sidecar: sequential, CPU-inline, chatty pipeline

`import_directory` (`sidecar/src/services/book_importer.rs:112`) then
processes strictly one book at a time, each with:

1. `existing_cover` — one DB read
2. PDF books: `pdf_cover_path` → **synchronous PDFium rasterization inline
   on the async runtime** (`book_importer.rs:231`, no `spawn_blocking`)
3. `upsert_book` — write
4. `apply_source_metadata` — several statements per book (source metadata,
   authors, subjects, effective recompute; FTS triggers fire per insert)
5. `get_book` — re-read the row we just wrote
6. `on_book` → `events.emit("import-progress", ...)` — **one JSON line per
   book to stdout**

No bounded parallelism, no batching of DB work into transactions, and the
parser results block the tokio worker rather than being delegated.
`#[tokio::main]` is the default multi-threaded runtime
(`sidecar/src/main.rs:21`), so the RPC loop survives, but the import itself
is serial: ~11k × (parse + rasterize + 5-ish DB round trips + IPC event).

Note the irony in the sequencing: the _watcher_ path already has the
cheap-change machinery — `file_stats` snapshots size+mtime
(`book_importer.rs:173`) and the reconciler diffs `list_book_files`
(enumeration without parsing, `library_scanner.rs:71`) against the DB —
but the bulk import path never uses it to skip or defer.

### Renderer: per-event O(n log n) state churn

Every `import-progress` lands in `useLibraryData`
(`frontend/src/hooks/useLibrary.ts:115`) → `patchBook`
(`useLibrary.ts:37`):

```ts
const index = existing.findIndex(...);        // O(n) scan
const next = [...existing, book];             // full array copy
next.sort((a, b) => a.title.localeCompare(b.title)); // full re-sort on insert
```

For 11k events: ~11k × O(n) scans + O(n log n) sorts ≈ billions of
comparisons (each a `localeCompare` — not cheap), ~1 GB-order of short-lived
array garbage, and **~11k separate React commits**, each re-running
LibraryView's filter/sort pipeline over the whole array and reconciling the
grid. The final `refresh()` would reconcile order anyway — the per-event
sort buys nothing.

### Renderer: no virtualization, eager covers

`LibraryView` renders the entire filtered array into the DOM in one go
(`frontend/src/components/library/LibraryView.tsx:267`,
`visible.map(renderItem)`): ~11k `BookCard`/`BookListItem` subtrees. Covers
are plain `<img src="tuxbooks://cover/...">` (`BookCover.tsx:32`) — no
`loading="lazy"`, no `decoding="async"` — each fetched through the custom
protocol handler (sidecar RPC) and decoded at whatever size extraction
produced (PDF covers are rasterized large, not normalized like Foliate's
256px cache). The roving-focus handler additionally runs
`querySelectorAll("[data-book-card]")` over the whole grid and `findIndex`
on every keypress (`LibraryView.tsx:133`).

This is the user's "library displays all 11000 items at once and memory
explodes" hypothesis — confirmed. GTK solves this with view recycling;
in DOM-land the equivalent is windowing/virtualization or
`content-visibility`.

## What to do (prioritized)

### P0 — stop the freeze (renderer)

1. **Render a bounded window of the grid.** Three implementations, in
   ascending effort: pagination (Thorium's `PAGESIZE = 50` model — plain
   page controls, trivially compatible with the existing roving-focus
   keyboard nav), a scroll-adjacency window that grows as the user scrolls
   (Foliate's `loadMore` model), or full virtualization
   (`@tanstack/react-virtual` grid mode — the GTK `GridView` analog, and
   the only one that keeps sort/filter instantly applicable across the
   whole library). Any of the three makes the DOM node count O(viewport);
   pick one, ship it, refine later.
2. **Batch import-progress updates.** Buffer incoming events and flush at
   most once per ~150ms (rAF or timer) into a single `setBooks`. 11k events
   become ~dozens of commits.
3. **Make `patchBook` O(1)**: maintain an id→index Map; append on insert
   without sorting (the completing `refresh()` already restores title
   order), replace in place on update.
4. `loading="lazy" decoding="async"` on covers — one-line change, big
   effect on startup decode cost even without virtualization.

### P1 — stream the import (sidecar)

5. **Stream the scan.** Turn `import_directory` into a pipeline over the
   `WalkDir` iterator: enumerate → parse → persist → emit, one bounded
   buffer in between. The user sees books appear within the first second,
   and peak memory drops to O(1) parsed book. This alone kills the
   "silent for hours" phase.
6. **Skip unchanged files.** Before parsing, compare `file_stats`
   (size+mtime, already persisted on the row) — a re-import of an existing
   library becomes a stat-only pass. The reconciler already proves the
   pattern works.
7. **Bound parallelism for CPU work.** Run parse + PDFium rasterization in
   `spawn_blocking` (or a small worker pool) with K ≈ 2–4 concurrent books;
   keep SQLite writes on the existing serialized path. Import wall time
   drops roughly by core count for the parse/rasterize phase.
8. **Coalesce sidecar-side events.** Emit a progress event every N books /
   T milliseconds (e.g. 25 / 250ms) plus a final summary; one per book is
   noise the renderer must then batch away anyway. (With #2 both together
   are belt and braces; either suffices.)

### P2 — polish

9. Consider deferring cover extraction for PDFs to a low-priority pass
   after the run (PDFium rasterization is the single most expensive
   per-book step; metadata is usable without the cover).
10. Wrap multi-book imports in a single transaction per chunk (e.g. 100
    books) — fewer fsyncs, same durability semantics as "run failed, roll
    back chunk, report".
11. Normalize cover sizes at extraction time (Foliate's 256px-wide cache
    bounds decode/texture cost per card permanently).

## References

- Foliate source: `github:johnfactotum/foliate` — `src/library.js`
  (`BookList.loadMore`, `#checkAdjustment`, `showGrid`),
  `src/data.js` (`saveCover`, `saveURI`), `src/utils.js`
  (`memoize`, `listDir`).
- Foliate issue #1623 — "Import multiple books or folder" (still the
  canonical request; confirms bulk import is not a solved problem there,
  just an absent one).
- Thorium Reader source: `github:edrlab/thorium-reader` (canonical:
  `readium/readium-desktop`) — `src/renderer/library/components/searchResult/AllPublicationPage.tsx`
  (`usePagination`, `PAGESIZE = 50`, `matchSorter`, debounced search),
  `src/renderer/library/components/dialog/FileImport.tsx` (explicit
  per-file import), `@r2-shared-js` metadata parsing in the Electron main
  process.
- TuxBooks audit points: `library_scanner.rs:96` (buffering scan),
  `book_importer.rs:112` (sequential loop), `book_importer.rs:231`
  (inline PDFium), `book_importer.rs:173` (existing stat machinery),
  `commands/library.rs:29` (per-book emit), `useLibrary.ts:37` (patchBook),
  `useLibrary.ts:115` (per-event setState), `LibraryView.tsx:267`
  (non-virtualized grid), `BookCover.tsx:32` (eager cover `<img>`).
- Field report: issue #61 comment — v0.0.3 machine recovers only after
  deleting `~/.local/share/com.tuxbooks.app` and importing in smaller
  batches.
