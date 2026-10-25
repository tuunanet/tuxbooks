# Research: PDF viewer performance findings

Status: evidence complete as of 2026-10-23. Baseline bench, rapid-scroll
render-state capture, and native thumb-drag capture all landed. This is the
input document for the spec/ticket round of the performance effort (branch
`perf/pdf-viewer-investigation`).

## Symptoms under investigation

Both were reported by the reader's user. The user's own eyes in a UAT
session are the acceptance gate for both; bench numbers here are evidence,
not the target, and `docs/PERFORMANCE.md` budgets remain the regression
guard.

1. **Rapid scrolling shows empty page slots for seconds.** Fast scrolling
   through a PDF leaves white placeholder slots visible for a couple of
   seconds before page content appears. Slow, page-at-a-time scrolling keeps
   up. Against GNOME Papers and other viewers, this delay is the main gap in
   the experience.
2. **The scrollbar thumb jumps during a drag.** Holding the reader's
   scrollbar thumb and dragging it does not track the cursor; the thumb jumps
   around. The scrollbar is Chromium's native scrollbar on the reader scroll
   container (`ReaderShell.tsx:768-792`, styled via `scrollbar-color` only);
   the app has no scrollbar-drag handler.

Reference implementation for PDF viewer behavior: GNOME Papers (standing
convention: ADR 0003, `docs/PDF-VIEW.md`, `docs/research/papers-scrolling.md`,
`vendor/papers` submodule, `oracle/` geometry harness).

## Method

- Bench conditions matching `docs/PERFORMANCE.md`'s recorded 2026-09-21
  runs: maximized window on this host (2643x1405, dpr 1.453, no dpr
  override), letter PDF at fit-width, current Electron/Chromium. The doc's
  true reference conditions are maximized 3840x2160 at dpr 1.0 and 2.0;
  this run is the "closest achievable" tier its PERF-2 row describes.
- Fixtures: the free ebook corpus (`just fetch-ebooks`, sha256 manifest,
  gitignored and absent on a fresh worktree, which skips the bench's
  missing-fixture scenarios). The bench seeds `GeoTopo.pdf` (image-heavy) as
  its PDF and `page-blanche.epub` as its EPUB; GeoTopo is the agreed
  scrolling-smoothness document.
- Baseline: `just bench-reader` on the real display; results in
  `artifacts/e2e/<runId>/bench-results.json` with a line appended to
  `bench-trend.jsonl`.
- Mechanism analysis below is code-level on this branch, cited file:line.
  `OBS` marks what the code does; `HYP` marks why it may cause a symptom.
- Scope guardrails agreed for the effort: the native scrollbar stays (escape
  hatch only with trace evidence); PDF viewer and the shared reader shell
  only; one fix per PR with before/after evidence; no new regression tests
  for the thumb fix (verification is the user's UAT).

## Baseline evidence (2026-10-23, this host)

`just bench-reader`, run `bench-2026-10-23T07-30-01-997Z-1f1s6`, window
2643x1405 at dpr 1.453, the same host and environment as the 2026-09-21
PDFium re-baseline entries in `docs/PERFORMANCE.md`, so those are the
comparison points. 4 of 5 scenarios passed. The EPUB chapter-change
scenario failed its "collect >= 3 samples" assertion (2 collected); that
failure is EPUB-side and outside this effort, noted here for the
maintainers.

PDF numbers (from `bench-trend.jsonl` line 1 and the run's console):

| Metric                                        | Value                                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| First page render after open                  | 720 ms                                                                                                               |
| Page-walk render→blit                         | n=17, p50 131.4 ms, p95 381 ms (PERF-2 target: p95 ≤ 100 ms; host's 2026-09-21 record: p50 149–172 / p95 209–243 ms) |
| Render→blit **during** fast continuous scroll | n=154, p50 204.8 ms, p95 292 ms                                                                                      |
| Scroll frame times (synthetic drag)           | n=228, p50 16.67 ms, p95 17.47 ms, max 33.3 ms; >16.7 ms: 33.8%, >32 ms: 1.3%, >50 ms: 0%                            |
| Idle frame times                              | n=28, p50 16.7 ms, p95 17.3 ms                                                                                       |
| Wheel settle (last wheel → sharp raster)      | 5026, 1951, 1952 ms (first gesture ~5 s, then ~2 s)                                                                  |
| Toolbar page turn                             | n=8, p50 50 ms, p95 66 ms                                                                                            |
| Zoom step                                     | n=4, p50/p95 55 ms                                                                                                   |
| Big-jump navigation                           | n=3, p50 40 ms, p95 66 ms                                                                                            |
| Live canvas bytes                             | 219.8 MB (PERF-4 cap 256 MB, holds)                                                                                  |

The frame clock mostly holds 60 fps during fast scroll (1.3% of frames
over 32 ms) while content arrival is slow. Renders during scroll run ~1.6x
slower at p50 than the page-walk and land far above the 100 ms PERF-2
target, and first-gesture wheel settle reaches seconds. That is the shape
of the user's complaint, frames drawn while pages stay white.

This run also showed a tooling quirk. The final `bench-results.json` held
only the last test's section (PDF fields null; trend line 2 writes `-1`s),
and the trend timestamps suggest the report module was instantiated twice
during the run, consistent with a worker restart. The PDF baseline above
survives in `bench-trend.jsonl` line 1 and console output. Worth folding
into the tooling ticket: investigate report persistence across scenarios.

## Symptom 1: empty slots during rapid scroll

### What is actually on screen

- Every page of the document mounts one slot div up front and slots never
  unmount: inline `width/height/marginTop` plus inline
  `backgroundColor: pageBackground ?? "#ffffff"` (`PdfPageSlot.tsx:72-89`,
  `PdfDocumentView.tsx:96-101`). The inline background exists precisely for
  "what a fast scroll shows" with no canvas mounted (`PdfPageSlot.tsx:81-85`).
- `data-render-state` is one of six documented states but only four are ever
  written: `unloaded`, `rendering`, `rendered`, `error`
  (`PdfPageSlot.tsx:9-15,76`, `PdfDocumentView.tsx:182-187`; `queued`/
  `loading` have no writer in `src`).
- An `unloaded` slot is only the colored rectangle; a `rendering` slot's
  canvas is a transparent 300x150 default box over a white wrapper until the
  first `blit()` sets its real size (`PdfDocumentView.tsx:261,216-227`,
  `PdfPageCanvas.tsx:108-125,594-607`). Unloaded and pre-blit rendering
  look identical, both a white page box. A white box held for seconds is
  the symptom.
- HYP: the perceived "empty placeholder" is this white box; nothing renders
  into it until a raster completes and blits.

### Why the wait reaches seconds (ranked mechanism contributors)

1. **Two render slots, reshuffled every frame.** `renderPermittedPages` is
   the first `MAX_CONCURRENT_RENDERS=2` unrendered pages of `renderOrder`
   (`PdfReader.tsx:118,836-841`); `renderOrder` is anchor-first by distance
   plus one preload page, byte- and count-capped
   (`PdfReader.tsx:789-801`, `pdfRenderPolicy.ts:43,184-198`). Its memo
   rebuilds on every IntersectionObserver delivery and anchor change
   (`PdfReader.tsx:801`), so during fast scroll priorities can reshuffle
   ~once per frame. Pages at priority 3+ never mount at all and stay
   `unloaded` while the two slots are busy.
2. **Cancellation discards progress; re-enabling restarts the 150 ms
   settle.** Effect re-runs cancel in-flight rasters
   (`PdfPageCanvas.tsx:566-569,445`); a priority flip to
   `renderEnabled=false` cancels and returns early
   (`PdfPageCanvas.tsx:391-393`), and every re-run after a first paint
   waits out a fresh 150 ms `RENDER_SETTLE_MS` (`PdfPageCanvas.tsx:172,442-461`;
   first paint and post-zoom runs start immediately, `:449-461`) that a
   further supersession discards before any pixels (`PdfPageCanvas.tsx:459`).
   A cancelled render never marks `renderedPages`, so its page keeps holding
   one of the two slots until the window moves
   (`PdfReader.tsx:836-841`). HYP: fast scroll repeatedly cancels,
   re-prioritizes, and re-settles work, so completed pixels arrive far later
   than raw raster time.
3. **Raw raster time is already 150-240 ms, serialized in one worker.**
   PERF-2 records p50 148.9-172.4 ms / p95 209.1-243.5 ms render-to-blit
   (`docs/PERFORMANCE.md:29`). One worker per document handles requests in
   arrival order; raster is synchronous WASM inside it
   (`pdfWorkerClient.ts:4-8,64`, `pdfiumWorker.ts:122-145,154-174`), so
   text layers for rendered pages (`PdfDocumentView.tsx:248-254`),
   `measurePages` batches (`pdfiumEngine.ts:60-74`), search, and sidebar
   thumbnails queue behind raster. A chunk-cache miss costs a synchronous
   1 MiB XHR inside the worker, blocking everything including rasters
   (`pdfRangeSource.ts:31-45,104-120`; watchdog only warns at 10 s,
   `pdfWorkerClient.ts:34-41`).
   HYP: N pages visible after a fast scroll need N × (queue wait + raster)
   through two slots and one worker; seconds follow for the tail.
4. **Fast scroll churn feeds 1 and 2.** IntersectionObservers deliver
   without an rAF/debounce layer per scroll frame
   (`usePdfVirtualization.ts:40-70,72-78`); each window change recomputes
   retention ring, mount set, and the two-slot list (`PdfReader.tsx:813-847`)
   and re-executes all document slots (slots are not memoized,
   `PdfDocumentView.tsx:178-264`). `measurePages` fires per window change
   and corrects not-yet-measured pages one round trip later
   (`PdfReader.tsx:896-901`, `usePdfGeometry.ts:85-117`), rewriting slot
   heights and `scrollHeight` with scroll anchoring deliberately disabled
   (`ReaderShell.tsx:776-786`; no compensation call site exists,
   `pdfLayout.ts:434-456`).
   HYP: corrections landing above the viewport shift content mid-scroll;
   corrections anywhere change `scrollHeight` (see Symptom 2).
5. **Per-frame commits around all of it.** `setViewport` commits at most
   once per scrolled frame (`usePdfViewport.ts:28-38,61-74`) but each commit
   rebuilds `pageRegions` with O(pageCount) math and a fresh Map
   (`PdfReader.tsx:173-201,1262-1268`); steady scroll costs about four
   `getBoundingClientRect` per frame across viewport and scroll tracking
   (`usePdfViewport.ts:63-64`, `usePdfScrollTracking.ts:101-104`), and the
   tracker calls `onPageChange` on every rAF sample
   (`usePdfScrollTracking.ts:113,126-128`).
   Note: PERF-5's threshold reads "React state commits from scrolling
   <= 2 per 1000 px of continuous scroll (page/section changes only)"
   (`docs/PERFORMANCE.md:32`), so viewport/IO/render commits fall outside
   its letter; the named Vitest verification does not exist in `src`.

### Hypotheses and their status after baseline and capture

- H1: two-slot gate + per-frame priority reshuffle starves the pages the
  user is looking at (contributors 1, 2, 4). Partly confirmed: the two-slot
  gate kept `unloaded` rare (1%), but in-flight work rarely completed
  during motion, which is contributor 2 doing the starving.
- H2: serialized worker + raster latency explains the tail once H1 lets a
  page through (contributor 3). Consistent with the baseline (p95 381 ms
  page-walk, p95 292 ms during scroll); not isolated from contributor 2.
- H3: synchronous range-fetch stalls show up as multi-hundred-ms gaps in a
  trace on first pass through uncached content (contributor 3). Still
  needs a trace.

### Capture evidence (2026-10-23: scripted rapid wheel scroll on GeoTopo)

Two passes, sampled every 25 ms: fast (9.0 s, 260 wheel events, 156,000 px
traveled, ~17,300 px/s, about 43 pages) and gentle (~8,000 px/s):

- **The white placeholder is the `rendering` state, not `unloaded`.** In
  the fast pass the viewport slot was `rendering` in 98% of samples
  (336/342), longest continuous streak **8,400 ms**; `unloaded` appeared in
  5 samples (1%). Slots are mounted and rasters are in flight, but pixels
  do not land while content keeps moving. The reported symptom,
  quantified: seconds of white during rapid scrolling.
- **After the stop everything lands fast.** All visible slots `rendered`
  within **314 ms** (fast pass) and 368 ms (gentle pass). The pathology is
  motion-only, matching the report that slow scrolling keeps up. If the
  user's UAT still finds seconds _after_ a stop, re-capture on their
  document before changing the ranking.
- At the gentle pace a page flips every ~450 ms, above raster time, and no
  `unloaded` sample appeared (that pass did not instrument the `rendering`
  share). At flick pace the flip interval drops to ~210 ms, at or below
  raster time through two slots and one serialized worker (baseline: p50
  131-205 ms, p95 up to 381 ms), and priority reshuffles cancel in-flight
  work, so blits rarely land during motion. Contributor 1 (pages never
  mounting) was minor here; contributors 2 and 3 dominate.
- `scrollHeight` never changed during either pass (uniform geometry, same
  as the thumb capture).

## Symptom 2: thumb jumps during a native drag

- OBS: in the nominal case (plain thumb drag: no zoom, no keyboard, no
  presentation) no app write-back fires. Direct scroll writes go through
  the `setScrollTop`/`setScrollLeft` helpers (`usePdfScrollTracking.ts:17-24`):
  `reanchorByFraction` only on `scaleChanged`
  (`PdfReader.tsx:1147-1148,1239-1242`), `restorePresentedPage` only on
  presentation exit (`PdfReader.tsx:1175,1182,1234-1237`), and the wheel
  fixup only after `commitWheelGesture` (`PdfReader.tsx:1049-1085,1561-1594`).
  The one path outside those helpers, `scrollIntoView` at
  `PdfReader.tsx:1246`, is suppressed for scroll-driven page changes by
  `scrollReportedPageRef` (`PdfReader.tsx:1288-1293`, pinned by
  `PdfReader.test.tsx:1044-1045`).
- Candidate causes, in order:
  - T1 (leading): `scrollHeight` mutates mid-drag when `measurePages`
    corrections rewrite slot inline heights (`PdfPageSlot.tsx:77-79`; effect
    `PdfReader.tsx:896-901` fires on window changes during the drag).
    Chromium maps the thumb against live scroll height, so the thumb's
    proportion and position shift under the pointer.
  - T2: a mid-drag fit-scale change via `documentMaxPageSize`
    (`usePdfScale.ts:42-45`, `pdfLayout.ts:357-366`) reaches
    `reanchorByFraction`, which writes `scrollTop` with only a page-change
    guard (`PdfReader.tsx:1239-1242`).
  - T3: main-thread commit bursts (previous section) delay the thumb's
    layout-driven repaint.

### Capture evidence (2026-10-23, trusted synthetic input, GeoTopo)

Real thumb drag: calibrated grab (probe at −9 px from the no-arrows model),
600 cursor px downward from scrollTop 11,616 of maxScroll 422,550, on a
scrollHeight of 423,915 px; expected motion 3,151 scroll px per 10 cursor
px. Results:

- **`scrollHeight` never changed during the drag** (0 height events over
  60 steps), so T1's mechanism was not exercised. That fits GeoTopo's
  uniform page geometry, where measurement corrections arrive as no-ops (or
  were already measured), so slot heights never move.
- **No jump reproduced.** The final position landed within 64 px of the
  original-geometry prediction across the ~190,000 px traveled (0.03%).
  Step deltas quantized to ~3,150 px multiples (0 / 1x / 2x) are the
  capture racing the frame clock, not app behavior.
- The mid-drag fit-scale write (T2) did not fire.

On a uniform-geometry document the native thumb tracks accurately, and the
reported jump did not reproduce here. The leading mechanism needs a
document whose page sizes correct mid-drag, mixed-size content that
plausibly describes the user's own documents. Evidence is still owed
before "native scrollbar stays" could ever be reopened (per the session
decision): a capture on a mixed-size document, and the user's own UAT
reproduction. T3 (commit bursts delaying the thumb repaint) was not
captured; it needs a trace taken during a heavy drag.

### Capture evidence (2026-10-24, trusted thumb drag, committed mixed-size fixture)

The owed mixed-size capture exists now as a committed, rerunnable
procedure (issue tuxbooks-x27.4):

- **Fixture** `tests/fixtures/books/thumb-capture-mixed.pdf`, sha256
  `4349ac0a7e0c8628ddd0a2d7aad0501f0708504632fb81c93715318476b6b0fb`,
  byte-deterministic from `scripts/make-thumb-capture-fixture.py`
  (rerun the script and commit; the bytes do not change). 392 pages: 8
  front-matter pages 500×650 win the opening sample (pages 1, 2, and
  392, median by area), so all 384 body pages (612×792 / 612×900 /
  612×720) are reserved at 650 pt and correct upward when measured;
  page 200 is oversized 700×1100, wider than every sampled page, to
  give the fit-width reference (T2) its chance. This is the synthetic
  branch of the ticket: no user document was supplied. If one arrives,
  the capture phase seeds exactly one book, so the user's document
  replaces it by name in `e2e/setup/environment.ts` (and the open
  label in the spec) and everything else stands.
- **Procedure** `e2e/specs/thumb-drag-capture.e2e.ts` via
  `just test-e2e-capture` (opt-in project, Xvfb, never CI): window
  requested at 1600×1000, width asserted; open the book, jump to ~8% (page ~40); grab the
  native thumb through a calibration probe around the arrow-buttons
  model (both runs grabbed at offset 0 with a 3 px nudge); install
  in-page instruments on the scroll container (8 ms per-frame sampler;
  a `scrollTop` setter patch that records programmatic writes — a
  native drag never writes the property, so every intercepted write is
  an app-driven re-anchor); drag 60 trusted mousemoves × 10 cursor px;
  then diff `scrollHeight` across samples, count intercepted writes
  inside the drag window, and compute thumb-versus-cursor error against
  the grab-time (frozen) geometry. The report lands in
  `artifacts/e2e/<runId>/thumb-drag-capture.json`. Assertions cover
  harness sanity only — the verdict is data, not a pass/fail gate.

**Verdict: the jump reproduced, and the leading mechanism (T1, layout
height corrections landing mid-drag) is confirmed by the numbers.** Two
runs on 2026-10-24, same shape both times:

|                                               | Run 1 (14:21Z)              | Run 2 (21:24Z)                                          |
| --------------------------------------------- | --------------------------- | ------------------------------------------------------- |
| Grab (scrollTop of scrollHeight 633,801)      | 52,260                      | 52,260                                                  |
| Drag ratio at grab                            | 692.4 scroll px / cursor px | 692.4                                                   |
| Predicted travel for 600 cursor px            | 415,432 px                  | 415,432 px                                              |
| Actual travel                                 | 262,231 px                  | 255,526 px                                              |
| Final thumb-vs-cursor error (frozen geometry) | −153,201 px (−58.4%)        | −159,906 px (−62.6%)                                    |
| Lost travel (predicted − actual)              | 153,201 px ≈ 190 pages      | 159,906 px ≈ 199 pages                                  |
| `scrollHeight` events during drag             | 23 (+21,871 px)             | 20 (+23,018 px)                                         |
| End state, live geometry: cursor vs thumb     | thumb off cursor            | cursor at 73.6% of track, thumb at 46.9% — 248 px apart |
| Re-anchor writes mid-drag (T2)                | 0                           | 0                                                       |

- **The height corrections the fixture guarantees land mid-drag.** The
  uniform-GeoTopo capture above saw zero `scrollHeight` events; here
  20-23 events (deltas 173-2,284 px) fire strictly inside the drag
  window as the render window measures reserved-at-650 pt pages, and
  `scrollHeight` grows +21,871 / +23,018 px while the thumb is held.
- **The thumb separates from the cursor materially.** Against the
  grab-time mapping the drag loses 58-63% of its travel (≈190-199 body
  pages); against live end-of-drag geometry the cursor sits at 73.6% of
  the usable track while the thumb sits at 46.9%. This is the reported
  symptom, quantified.
- **T2 (reanchorByFraction) did not fire.** Zero programmatic
  `scrollTop` writes mid-drag in either run, including across the
  oversized page 200. On this evidence the drag-time guard the spec
  mentions for T2 is not needed.
- **Per-event attribution is open for the fix ticket's trace.** 23 of
  59 per-step deltas were zero (run 2); frame-clock aliasing
  redistributes deltas across steps but preserves totals, so the
  153k-160k px shortfall is real lost travel. Whether each correction
  event drops in-flight travel through thumb re-derivation, or
  main-thread commit bursts eat the moves (T3's signature), needs a
  trace taken during a heavy drag; both runs lost the same 36-38% of
  predicted travel while corrections were landing.

Fix ticket: tuxbooks-x27.5 (fix only if the user's UAT reproduction
agrees; the capture covers the mixed-size half of the owed evidence).

### Fix (2026-10-25, branch perf/pdf-thumb-reference)

The fix ports the reference behavior of thorium-reader's PDF viewer
(edrlab/pdf.js 87c6007, PDF.js v6.3.289): its viewer fetches every page's
real size right after the first page renders (`web/pdf_viewer.js`,
"Fetch all the pages" — `PagesCountLimit.FORCE_LAZY_PAGE_INIT` 5000,
`PAUSE_EAGER_PAGE_INIT` 250), so slot heights settle before a thumb drag
can start. `usePdfGeometry` now runs the same sweep after first paint
(waves of 250, one commit per wave, the lazy on-approach path kept for
documents above 5000 pages), replacing the measure-on-approach-only
policy that produced the mid-drag `scrollHeight` corrections.

Capture rerun on the fixed build (`just test-e2e-capture`, same fixture
and procedure): `heightEventsDuringDrag` 20-23 → **0**, final error
−153,201/−159,906 px (−58.4/−62.6%) → **+3,951 px (+0.875% of 451,343 px
traveled, ≈ 5 pages)**, end-of-drag cursor 73.0% vs thumb 73.9% of the
track (8 px apart, thumb under cursor) against the unfixed 73.6% vs
46.9% (248 px apart). With zero in-drag height events the trace question
resolves for this document: thumb re-derivation is out (there is no
`scrollHeight` change to re-derive against), and the small overshoot is
input-side — per-step quantization aliasing, the same redistribution the
unfixed capture saw, now without a layout mechanism behind it
(`deadSteps` 23/59 → 4/59). Report:
`artifacts/e2e/capture-2026-10-25T02-42-15-906Z-1s5hz/thumb-drag-capture.json`
(a first run on the same build,
`capture-2026-10-25T02-26-26-327Z-1r41z`, landed the same numbers).
User UAT is still the acceptance gate; the capture is evidence, not a
regression gate (no thumb regression test, by decision).

### Second mechanism from UAT (2026-10-25, scroll-write telemetry)

The first UAT rerun on the fixed build still reported a held thumb
flying around. The opt-in zoom telemetry (plus the scroll-write recording
shipped for it) captured the session and acquitted the sweep: scrollHeight
(553,126) and scale (2.2448) were constant through every drag, and the
only app-driven scrollTop writes were the open restore and one window
resize. What the log showed instead was oscillation: consecutive scroll
frames jumping −49,599 / +85,670 / −69,138 / −82,665 px, the anchor page
sawtooting tens of pages, starting once the drag passed a few pages per
frame.

The writer is the one path the e2e setter patch cannot see:
`scrollIntoView` in the re-anchor effect's fallback. Its guard compared
`currentPage` against the tracker's LAST reported page, but the tracker
stamps synchronously at frame rate while React commits `currentPage` a
frame or two behind. Past a few pages per frame of drag speed, a stale
commit's page no longer equalled the last report, the guard missed, and
the fallback scrolled the view back toward the stale page while the held
thumb dragged forward — the two fought at frame rate. That is also the
likely driver of the session's `Maximum update depth exceeded` (an
effect→scroll→setState storm), though the component stack is still
unconfirmed.

Fix: the guard now skips any page change whose target is in a bounded set
of recently scroll-reported pages (64), so stale commits stay still;
`goToPage` deletes its target first, so navigation to a recently scrolled
page still re-anchors. Unit tests pin the stale-write silence (it fails
against the old guard) and the navigation landing.

UAT after the guard fix passed (2026-10-25, user session, zoom-log JSON):
34.6 s of dragging including fast flicks at fit-width scale 4.82 on the
1.18M px layout, with exactly three geometry events — open/restore, a
window resize refit, and a zoom change — each paired with its legitimate
re-anchor write, flat geometry between them, no oscillation signatures,
and no update-depth errors. The ticket's thumb half is verified by UAT;
the bench rerun rides the next scheduled bench run.

## Tooling gaps

- The bench's synthetic drag writes `container.scrollTop` on a 16 ms
  interval (`bench-reader.e2e.ts:362-407`); it is not a thumb drag, so it
  cannot reproduce or verify Symptom 2. Verification there is the user's UAT
  by decision; investigation traces are evidence, not tests.
- Missing for Symptom 1 (accepted as the first tooling ticket): a GeoTopo
  rapid-scroll scenario measuring scroll-stop to sharp content and sampling
  the `data-render-state` distribution over time. This doc's numbers came
  from one-off capture scripts run against the bench project; the ticket
  promotes the scenario into the suite.
- Trace capture is feasible: the harness is Playwright 1.63 attaching over
  CDP (`e2e/fixtures/electron-app.ts:24,104-109`); no `tracing.start` or
  `newCDPSession` usage exists yet, so it is a new but small pattern.

## Existing tracker issues (adopted into this effort's review)

- `tuxbooks-d4k` (P2): PERF-2 p95 re-baseline at reference conditions.
  Mechanism context: contributor 3 above; baseline feeds its evidence.
- `tuxbooks-4yc` (P2): stale pre-resize base x1.2 under load in the
  wheel-zoom fit pipeline. Confirm against baseline; zoom path, adjacent to
  this effort's symptoms.
- `tuxbooks-u8q` (P3): an `unloaded` slot after `scrollToSlot` never enters
  the render window within 60 s on unmodified main. Mechanism context: entry
  paths are the IntersectionObserver sets and the anchor
  (`usePdfVirtualization.ts:40-70`, `PdfReader.tsx:790`); both failing for a
  page is the same family as Symptom 1's starvation. Confirm via baseline.
- `tuxbooks-j56` (P3): axis-locked wheel scrolling. Confirm relevance;
  likely out of scope for these two symptoms.

## Papers proposals vs this mechanism

From `docs/research/papers-scrolling.md` (proposals, not facts; validate
against our own evidence):

- **R1** never defer a raster for an in-window page; order instead of block
  (lines 511-521). Targets contributors 1-2 directly: the strongest
  candidate for Symptom 1.
- **R2** one running render plus one latest-wins pending render per page
  (523-528). Supersession exists here as cancel-and-restart; candidate.
- **R3** retain rendered bitmaps for visible +/-3 pages under a byte budget
  (530-537). Already implemented: retention ring cites R3
  (`PdfReader.tsx:814-824`, `pdfRenderPolicy.ts:200-251`).
- **R4** paper-colored page box behind the canvas, "never a hole"
  (539-546). Already implemented; rationale cited at `PdfPageSlot.tsx:22-29`.
  Visual cushion only, not a latency fix.
- **R5** cancel and discard stale work instead of pausing all work
  (548-556). Partially implemented; the current cancellation path is what
  contributor 2 shows restarting work, so evaluate together with R1/R2.
- **R6** recompute the render window once per coalesced frame, not per
  scroll event (558-563); explicitly a keep-and-cite. OBS: window updates
  currently arrive uncoalesced per IO delivery (`usePdfVirtualization.ts:40-70`).
- **R7** a scroll must only move pages, never re-rasterize (565-571),
  framed as a review rule. OBS: priority flips cancel and restart in-flight
  rasters during scroll, which R7 would rule out; test against capture.
- **R8** keep raster concurrency small and spend the budget on ordering plus
  direction-ordered preload (573-580). Concurrency is already 2; the
  ordering half is open.
- **R9** size-policy prior art; covered by PERF-1, citation only (582-586).
- Explicit non-findings: no drag-tied render mode exists in Papers; the
  white placeholders during a Papers drag are an interpretation, not a
  stated behavior, and no R10 was added (441-461).

## Candidate fixes (draft ranking against the evidence above)

1. **Tooling first (accepted as the first ticket).** Build the GeoTopo
   rapid-scroll scenario into `just bench-reader`, covering render-state
   distribution during scroll and scroll-stop-to-sharp, and fix report
   persistence so `bench-results.json` survives all scenarios (baseline
   section). The one-off capture scripts used here reproduce the
   measurements until then.
2. **Order, don't defer (Symptom 1, R1/R2/R7).** Evidence: `rendering`
   in 98% of fast-scroll samples, longest white streak 8,400 ms, 314 ms to
   sharp after stop. The fix stops priority reshuffles from cancelling
   in-flight rasters of the visible page, settles once per page instead of
   per effect re-run, and guarantees a started raster gets blitted. It can
   also add direction-ordered preload (R8).
3. **Wake safety net (`tuxbooks-u8q`).** `unloaded` was rare on GeoTopo
   (1% of samples), but u8q's never-wakes path is the same family.
   Re-check the render window on scroll-stop so a page missed by both
   entry paths cannot stay `unloaded`.
4. **Thumb jump (Symptom 2).** Not reproduced on uniform GeoTopo, with
   zero `scrollHeight` changes and end-of-drag tracking error of 64 px over
   190,000 px. Evidence is owed before implementing: a capture on a
   mixed-size document (T1's mechanism needs size corrections landing
   mid-drag) plus the user's UAT reproduction. T2's guard only if a trace
   shows `reanchorByFraction` firing mid-drag. Verification is the user's
   UAT alone, with no regression test by decision.
5. **Worker stall trim (H3).** Unchecked so far; the 5,026 ms first
   wheel-settle and PERF-2's recorded worker dominance keep it on the
   list. Capture inside item 1's ticket or during fix 2's investigation,
   acting only if the trace shows synchronous range fetches blocking
   raster.

Each becomes a ticket after the final review round; evidence collected as
before/after pairs per PR.
