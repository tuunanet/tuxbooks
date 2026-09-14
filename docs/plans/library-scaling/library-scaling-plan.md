# Library scaling plan (issue #61)

Goal: make bulk imports of ~10k+ books and a library of that size work —
no freeze, bounded memory, honest progress — and prove it with
machine-checked gates. Based on the research in
`docs/research/scaling-bulk-imports.md` (Foliate / Thorium comparison and
the TuxBooks audit); every fix below pins an audit point from that doc.

Decisions taken during planning (2026-09-13):

- **Grid windowing: full virtualization** (`@tanstack/react-virtual`), with
  an app-level focus model for keyboard navigation and explicit scroll
  restore. Not pagination, not scroll-growth.
- **Event coalescing on both sides**: renderer batches commits (~150 ms
  flush); sidecar throttles emission (~250 ms flush carrying accumulated
  books). Either alone suffices; both together keep each side simple.
- **Sidecar rework: streaming + bounded parallelism, covers inline.** Parse
  as you walk, skip unchanged via the existing stat pattern,
  `spawn_blocking` with ~3 concurrent workers, one transaction per ~100
  book chunk. The deferred-cover second pass is explicitly out of scope.
- **Gates: budgets + seeded E2E** per `docs/PERFORMANCE.md` convention
  (PERF-15/16, deterministic assertions, no timing in CI).
- **Delivery: three phased PRs** — renderer, sidecar, gates/E2E/docs. Each
  independently shippable; 0.0.5 takes whatever has landed.

## Current state (verified)

- `scan_directory` (`sidecar/src/services/library_scanner.rs:96`) parses
  every book inline during the walk and buffers all results — no event,
  no persist, O(n) parsed books in RAM before the import loop starts.
- `import_directory` (`sidecar/src/services/book_importer.rs:112`) is a
  sequential loop: per book one DB read, inline PDFium rasterization
  (`:231`), upsert, `apply_source_metadata`, re-read, emit. No
  parallelism, no transactions, no skip-if-unchanged on this path.
- The reconciler already proves the skip-if-unchanged pattern
  (`library_reconciler.rs:335-364`: stat-compare `file_size`/`file_mtime`
  before parsing); the bulk import path just doesn't use it.
- One `import-progress` event per persisted book
  (`sidecar/src/commands/library.rs:29,52`), forwarded per line by
  Electron (`Sidecar.forward`), each landing in
  `useLibraryData` (`frontend/src/hooks/useLibrary.ts:115`) as a separate
  `setBooks` → `patchBook` (`:37`: O(n) findIndex + array copy + full
  title re-sort on insert).
- `LibraryView` renders the entire filtered array
  (`frontend/src/components/library/LibraryView.tsx:267`); covers are
  eager `<img>`s (`frontend/src/components/books/BookCover.tsx:32`);
  roving-focus uses `querySelectorAll` over all cards
  (`LibraryView.tsx:133`).
- `ImportStatus` consumes the import run lifecycle (`importState`), not
  per-book events — unaffected by the event contract change.

---

## Phase 1 — Renderer: virtualized library, batched updates (PR 1)

Outcome: the library grid renders a bounded window regardless of library
size; an 11k-event import produces dozens of commits, not 11k. The app
stays interactive during imports.

### Virtualization

- [x] Add `@tanstack/react-virtual` to `frontend` (zero-dep, MIT).
- [x] `LibraryView` grid: replace `visible.map(renderItem)`
      (`LibraryView.tsx:267`) with `useVirtualizer` over row ranges —
      column count computed from measured container width (reuse the
      `columnCount(container)` helper), row height derived from the fixed
      card aspect (cover 2:3 + text block + gap), `overscan: 2` rows.
- [x] `LibraryView` list view: same virtualizer, simpler row estimate.
- [x] Cards keep their current markup; nothing about a card changes.

### Keyboard navigation & scroll restore (the rework)

- [x] Replace `querySelectorAll`-based roving focus
      (`LibraryView.tsx:129-176`) with a `focusedIndex` in component state:
      arrows move the index, `scrollToIndex(index, { align: "auto" })`
      brings the row into view, an effect focuses the card element
      (`data-book-card`) after it mounts, Enter opens detail.
      Home/End map to first/last index. ArrowLeft/Right keep column-aware
      stepping via the computed column count.
- [x] Restore scroll when returning from detail/reader: store the grid
      `scrollTop` when navigating away (app state alongside
      `selectedBookId`), restore via `scrollToOffset` on mount.

### Batched event handling

- [x] `useLibraryData`: buffer incoming `import-progress` and
      `library-changed` payloads in a ref; flush into a single
      `setBooks` at most every ~150 ms (timer; flush-on-unlisten). N
      events per window ⇒ one React commit per window.
- [x] `patchBook` O(1): maintain an id→index `Map` alongside the array;
      update replaces in place; insert appends without sorting. The
      completing `refresh()` already restores title order (`list_books`
      sorts); document that ordering is eventually-consistent during an
      import (unchanged from today's behavior in practice).
- [x] `BookCover`: `loading="lazy" decoding="async"` on the `<img>`
      (`BookCover.tsx:32`) — cheap defense even though virtualization
      already bounds mounts.

### Gates that pin this phase

- [x] PERF-15 (budget row + unit test): rendered `[data-book-card]`
      count never exceeds `viewport rows + overscan` for any library
      size — test renders 2,000 books with stubbed geometry
      (`tests/mocks/dom.ts`) and asserts the cap.
- [x] PERF-16 (budget row + unit test): N synthetic import-progress
      events produce ≤ ⌈N / batch window⌉ commits — assert via render
      counter on a probe component.
- [x] `docs/PERFORMANCE.md`: add PERF-15/16 rows (Required / Status /
      Verified-by), touch-list entries for `LibraryView`, `BookCover`,
      `useLibrary`.

### Verification

- [x] `just check` green.
- [x] Existing E2E suite 53/53 (library specs exercise the virtualized
      grid unchanged from the user's point of view).
- [ ] Manual: seed ~1,500-book folder, import, UI stays interactive;
      scrollbar drag to middle lands instantly.

Phase 1 implementation notes (deviations discovered while building):

- The virtualizer's scroll element is the library view's **own** scroller
  (`LibraryView` renders `flex h-full` with an inner `overflow-y-auto`
  area), not the app `main` — this keeps the scroll element owned by the
  view, makes the header effectively sticky, and avoids fragile
  `closest("main")` lookups. `main` still scrolls for the detail view.
- No-layout environments (jsdom, SSR) get a **bounded static fallback**:
  when the virtualizer's window is empty, up to `FALLBACK_ROWS` (60)
  render statically. Without it, tanstack measures jsdom rows as 0-height
  and either renders nothing or (worse) every row. Guarded
  `measureElement` keeps the estimate when a row reports 0 height.
- Tests gained a controllable `ResizeObserver` mock
  (`tests/mocks/resizeObserver.ts`: `fireResizeOn(target, w, h)`) — the
  virtualizer's rect measurement happens only inside the observer
  callback, and per-element targeting avoids re-measuring rows with the
  test geometry.
- `pnpm-workspace.yaml`: dated `minimumReleaseAgeExclude` pins for the
  already-locked `rollup@4.63.1` platform binaries and
  `@noble/hashes@2.4.0` (no advisory — re-resolution for the new
  dependency tripped the age gate on locked versions); remove after
  2026-09-28.

---

## Phase 2 — Sidecar: streaming, skipping, bounded parallel import (PR 2)

Outcome: books appear (and events flow) within the first second of a bulk
import; peak sidecar memory is O(a few parsed books), not O(library);
re-importing an existing folder parses nothing unchanged; PDF-heavy
imports use the cores.

### Streaming pipeline

- [x] Replace the `scan_directory` collect-then-loop in
      `import_directory` with a streamed pipeline: enumerate first with
      `list_book_files` (cheap, sorted, already exists at
      `library_scanner.rs:71`), then walk that list file-by-file —
      stat → skip-or-parse → persist → emit. No `Vec<ScannedEntry>` of
      parsed books ever exists.
- [x] Report shape: `ImportReport` gains `skipped: usize` (unchanged
      files). Frontend import summary shows it ("N already in library").
      `scan_library`/`import_paths` command signatures otherwise
      unchanged.

### Skip-if-unchanged (reuse the reconciler's contract)

- [x] Before parsing, stat the file and compare against the row's
      `file_size`/`file_mtime` (same comparison and same
      unreadable-stats-means-reimport default as
      `library_reconciler.rs:364`). First import of a folder parses
      everything (rows don't exist yet); re-imports become stat-only
      passes.

### Bounded parallel parse + inline covers

- [x] Parse (EPUB zip/XML and PDF) and cover extraction move to
      `tokio::task::spawn_blocking`, gated by a `Semaphore` with ~3
      permits (constant with a comment; not configurable via RPC).
- [x] Shape: K parser tasks feed a bounded `mpsc`; a single persister
      consumes in arrival order, so SQLite writes stay serialized on the
      existing pool path. PDFium covers stay inline in the blocking task
      (deferred-cover pass explicitly rejected for now).
- [ ] Transaction per ~100-persisted-book chunk (`pool.begin()` /
      `commit()`); a chunk failure rolls back that chunk and its books
      report as failed, the run continues with the next chunk. Per-book
      parse failures keep their current individual reporting.

### Sidecar-side event throttling

- [x] Accumulate persisted books; emit `import-progress` at most every
      ~250 ms or ~25 books, plus a final flush. The event payload becomes
      an array of books (`{ books: Book[] }`) — the one wire change,
      consumed by the renderer batching from Phase 1 (which stays as
      defense for watcher bursts).
- [x] Update `bridge.ts` (`onImportProgress`), `useLibraryData`,
      `ImportStatus` (uses run lifecycle only — verify), unit tests, and
      `e2e/specs/helpers.ts` if the specs listen to the event.
- [x] `emit_book_changed` and watcher events unchanged.

### Verification

- [x] Rust unit tests: skip-unchanged (re-import → all skipped; mtime
      bump → re-parsed) and batched emission (both books land in one
      `import-progress` event with a `books` array).
- [ ] Rust unit tests deferred: parse-watermark ceiling (needs a parse
      injection point; the bound itself is a 3-permit `Semaphore` around
      `spawn_blocking`) and chunk rollback (deferred with chunked
      transactions, see notes).
- [x] `just check`, `just coverage` green.
- [x] E2E suite green (import spec exercises `scan_library` for real).

Phase 2 implementation notes (deviations discovered while building):

- **Chunked transactions deferred.** `upsert_book` +
  `apply_source_metadata` reach the database through deep repository call
  chains (source upsert, author/subject replacement, effective recompute)
  that all take the pool; making them executor-generic to run inside an
  explicit transaction is a cross-cutting refactor whose win is small
  against SQLite WAL autocommit. Deferred until measurements say
  otherwise.
- The batched wire payload is `{ books: Book[] }` on the same
  `import-progress` event name; the count- and time-triggered batcher
  lives in `commands/library.rs` (`ProgressBatcher`), so the streaming
  service stays wire-agnostic. Time-triggered flushes share the code path
  with count-triggered ones and are not separately unit-tested.

---

## Phase 3 — Large-library E2E + docs consolidation (PR 3)

Outcome: the scale behavior is machine-checked headlessly, and the docs
describe the new import pipeline and library contracts.

### Synthetic corpus + E2E

- [ ] Add a corpus generator (extend `scripts/make-epub-fixtures.py` or a
      sibling `scripts/make-epub-corpus.py`): deterministic minimal EPUBs
      (one tiny xhtml + minimal OPF, varied title/author), N via CLI,
      written to a target dir. Must generate ~1,500 books fast (seconds).
- [ ] New `e2e/specs/library-scale.e2e.ts` (seeded flavor): generate the
      corpus into the fixture tempdir, import it through the UI, then
      assert — structural only, no timing per `docs/PERFORMANCE.md`: - import completes with the full count in the header; - `[data-book-card]` count within the PERF-15 cap after settle; - scrolling to the middle of the scrollbar renders a different
      window (title at top changes); - UI liveness probe: change the sort, assert the first card changes
      (the renderer processed a full-library operation while big); - a second import pass reports everything skipped (Phase 2
      contract).
- [ ] Wire the corpus into the E2E fixture build so `just test-e2e`
      stays self-contained and terminates.

### Docs

- [ ] `docs/ARCHITECTURE.md`: import pipeline section — streaming +
      skip + bounded parallelism + chunked transactions; batched
      `import-progress` contract.
- [ ] `docs/PERFORMANCE.md`: touch-list additions (`book_importer`,
      `library_scanner`, corpus spec).
- [ ] Issue #61: post results (corpus size, observations) and close with
      the fix PRs referenced.

### Verification

- [ ] `just check`, `just test-e2e` (now including the scale spec),
      `just coverage` green.

---

## Acceptance mapping (issue #61)

- Cause 1 — renderer event flood: Phase 1 batching + Phase 2 throttling;
  pinned by PERF-16.
- Cause 2 — blocking sidecar work: Phase 2 `spawn_blocking` + bounded
  concurrency.
- Cause 3 — watcher feedback storm: unchanged watcher semantics; Phase 2
  skip-unchanged removes the re-parse amplification; Phase 1 batching
  absorbs event bursts.
- Cause 4 — unbounded memory: Phase 1 virtualization (renderer), Phase 2
  streaming (sidecar); pinned by PERF-15 and the corpus E2E.
- Field report (crash → only data-dir reset recovers): Phase 2 streaming
  keeps the UI responsive so imports can be cancelled/observed; the
  startup catch-up path already diffs via stats and never re-parses
  unchanged files.

## Out of scope

- Deferred second-pass cover extraction (rejected during planning; revisit
  only if PDF-heavy imports remain slow after Phase 2).
- Cover size normalization at extraction (research P2.11).
- Server-side sort/filter/pagination for the grid (renderer handles full
  sets fine once virtualized; revisit at ~100k books).
- Any change to metadata curation, merge, or the watcher/reconciler
  semantics.
