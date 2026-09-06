# Performance budgets and metrics

The readers are budgeted in **pixels and bytes, not element counts**. Every
surface they produce scales with viewport area, and the app must stay smooth
at a maximized 3840×2160 window — not just at the default 1100×720 size
(the investigation behind this contract: `docs/performance-4k.md`).

Like the coverage gate (`docs/coverage.md`), budgets are changed only case
by case, with the reason recorded in the same change. Unlike coverage, not
every budget is machine-enforced yet; the Verified-by column states what
holds each one today, and what must hold it in a change that touches it.

## Reference conditions

All numeric budgets are evaluated at: maximized window on 3840×2160,
devicePixelRatio 1.0 **and** 2.0, letter PDF page (612×792 pt) at fit-width
zoom 100%, EPUB default (paginated) flow, WebKitGTK ≥ 2.46 (Skia). A change
that makes any budget worse at reference conditions must state the measured
delta in the PR description.

## Budgets

| ID      | Metric                                                      | Required                                                                                                                                         | Status (2026-09-06)                                   | Verified by                                                                                    |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| PERF-1  | PDF page canvas backing store (`displayed px × dpr²`)       | ≤ 2²⁵ px total **and** ≤ 8192 px per dimension; CSS upscales beyond that                                                                         | Uncapped — violates at 4K (`docs/performance-4k.md`)  | Unit test pinning the cap math (jsdom `devicePixelRatio`)                                      |
| PERF-2  | Visible-page raster latency (render start → blit)           | p95 ≤ 100 ms at reference conditions                                                                                                             | Violates at 4K (hundreds of ms)                       | Manual measurement (below); diagnostic attr when added                                         |
| PERF-3  | Bitmap cache occupancy after one down-up scroll oscillation | ≥ 2 buffers retained; cache byte budget ≥ 2 × largest page buffer                                                                                | Holds 1 at 4K (48 MB budget < one page)               | `data-pdf-bitmap-cache` attr + unit test on budget math                                        |
| PERF-4  | Total bytes of mounted page canvases                        | ≤ 256 MB at reference conditions (byte budget governs; count cap stays ≤ 8)                                                                      | Count-only — up to ~0.6–2 GB at 4K                    | Derived from slot/canvas state in unit tests                                                   |
| PERF-5  | React state commits from scrolling                          | ≤ 2 per 1000 px of continuous scroll (page/section changes only); scroll handlers rAF-coalesced                                                  | OK — do not regress                                   | Vitest with synthetic scroll events                                                            |
| PERF-6  | Compositing hygiene                                         | No `box-shadow`/`filter`/`backdrop-filter`/`blur` on page-sized or larger layers (canvases, section iframes); decorations live on cheap wrappers | Violates (`shadow-sm` on page canvases)               | Review + `grep` over reader components                                                         |
| PERF-7  | EPUB scrolled-flow relocation debounce                      | ≥ 200 ms (vendored paginator debounces 250 ms)                                                                                                   | OK — do not override upstream                         | Code review; vendored submodule stays untouched                                                |
| PERF-8  | EPUB paginated per-turn raster volume                       | ≤ 1 viewport area per page turn (one column/viewport)                                                                                            | OK by construction                                    | Review when touching paginator settings (`max-column-count`, margins)                          |
| PERF-9  | Reading-progress write discipline                           | Saves debounced ≥ 1 s; first armed save skipped (opening writes nothing)                                                                         | OK — `useReaderProgress` contract                     | Existing `useReaderProgress` unit tests                                                        |
| PERF-10 | Book payload IPC                                            | Raw bytes, never JSON/base64-encoded growth (`get_book_bytes`)                                                                                   | OK                                                    | E2E + review of `src-tauri/src/commands/`                                                      |
| PERF-11 | GPU-stack hygiene                                           | No unconditional `WEBKIT_DISABLE_DMABUF_RENDERER`/`WEBKIT_DISABLE_COMPOSITING_MODE` in shipped code; startup logs dpr, content area, fit scale   | Nothing sets the env vars; diagnostics not yet logged | `grep` + review (`docs/performance-4k.md` — these flags silently drop WebKitGTK to slow paths) |

## Rules for changes

- Any change touching the touch-list below must re-read this doc and keep
  every budget at or better than required — the fix for a violation is a
  fix, not a raised threshold.
- Growing per-page raster pixels, per-frame composited area, or per-scroll
  main-thread work requires the measured delta at reference conditions in
  the PR description and updated pinning tests in the same change.
- New diagnostics must be deterministic DOM attributes (`data-*`), never
  timing assertions — E2E runs headless under `xvfb-run`, where timings are
  unreliable. Timing budgets (PERF-2) are measured manually or via logs,
  not asserted in CI.

## Touch-list

Re-run the relevant verifications when editing:

- `PdfPageCanvas` / `pdfBitmapCache` / `usePdfVirtualization` / `PdfReader`
  render-policy constants (`MAX_ACTIVE_CANVASES`, `MAX_CONCURRENT_RENDERS`,
  `ZOOM_LEVELS`) — PERF-1 to PERF-6.
- `usePdfScrollTracking`, `ReaderShell` scroll container — PERF-5, PERF-9.
- `EpubReader` flow/appearance wiring, any paginator option forwarding —
  PERF-7, PERF-8.
- `useReaderProgress`, reader persistence commands — PERF-9, PERF-10.
- `tauri.conf.json` window config, main-process env setup — PERF-11.

## How to measure

- **Unit (deterministic):** mock `devicePixelRatio` in jsdom and pin the
  cap/budget math (PERF-1, PERF-3, PERF-4) and scroll-commit counts
  (PERF-5, synthetic scroll events).
- **E2E (deterministic attrs only):** assert on `data-pdf-bitmap-cache`
  (`entries:bytes`) and `data-render-state` churn — e.g. cache occupancy
  after a scripted scroll oscillation.
- **Manual (timings):** log `performance.now()` around `page.render` →
  blit per page at reference conditions; record p95 before/after engine,
  scale, or virtualization changes. For frame-level attribution on
  WebKitGTK 2.50+, use Sysprof tracing marks.
