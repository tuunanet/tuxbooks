# Reader performance — bench findings and handover

Follow-up to `docs/research/performance-4k.md` (the original 4K investigation)
and `docs/plans/performance-4k-plan.md` (whose Phases 0–5 are implemented).
This document hands over the state after the benchmark suite was built and
used: what was measured, what was ruled out, what remains unexplained, and
the ordered list of next levers. Read `docs/performance.md` for the budget
contract and `just bench-reader` for the measurement tool. Its two open
questions were answered in the follow-up `docs/research/webview-frame-clock.md`
(frame clock: WebKitGTK engine-level; dpr 2: KDE fractional-scaling fiction,
no clamp warranted).

## Executive summary

1. **All app-side budget work from the 4K plan is implemented and pinned by
   tests**: two-tier render cap (2²⁴ preferred / CSS floor / 2²⁵ hard),
   320 MB bitmap cache, byte-budgeted render window, chrome off the canvas
   layer, blit without realloc, bounded preload, full diagnostics.
2. **A headed benchmark suite now exists** (`just bench-reader`): real-book
   fixtures, maximized window, mid-book start, synthetic scrollbar drags
   with rAF frame sampling, an idle-cadence baseline, and the deterministic
   PERF-1/3/4 budget assertions.
3. **The decisive finding is environmental**: the app's webview runs its
   frame clock at ~32 ms (≈31 fps) **while idle** — independent of window
   size (3840×2160 → 5400×2882 device px), content, app pixel budgets, and
   the WebKitGTK rendering path (DMABUF on/off). The desktop itself is
   smooth at 60 fps (Wayland, KWin). **No app-side pixel reduction can lift
   this ceiling** — it is the dominant smoothness limiter.
4. Scroll work adds only ~11 ms on top of that ceiling (drag p50 ≈ 43 ms vs
   idle 32 ms), and the **same** delta appears for PDF (canvas layers) and
   EPUB (text tiles).
5. Render→blit latency (PERF-2) still violates its 100 ms p95 budget at
   maximized dpr 2 (p95 ~200–330 ms in the page walk) — but that metric is
   wall-clock around a time-sliced raster and is inflated by the same frame
   clock; treat it as uncalibrated until the ceiling is resolved.

## The benchmark suite (what exists and how to use it)

- `just bench-reader [WxH]` — headed, opt-in, never CI. Maximizes the
  window (`WxH` overrides), seeds only the real-book fixtures in
  `tests/fixtures/books/EBooks/Agents/`, starts mid-book.
- Three scenarios in `e2e/specs/bench-reader.e2e.ts`:
  1. **PDF page walk** — discrete page-by-page steps collecting
     `data-pdf-render-ms` (per-page render→blit) plus the deterministic
     budget assertions (PERF-1 buffer caps, PERF-3 ≥ 2 cached buffers after
     an oscillation, PERF-4 live-canvas byte bound). Visually this one
     _jumps_ — it is a measurement walk, not a smoothness scenario.
  2. **PDF scrollbar drag** — continuous scroll deltas (~48 px per 16 ms
     tick) on the shell scroll container while a rAF sampler records frame
     intervals.
  3. **EPUB scrollbar drag** — continuous (scrolled) layout via the
     appearance popover, mid-book via the engine's `goToFraction(0.5)`,
     drag driven through the vendored paginator's public
     `scrollToAnchor(fraction)` (re-anchored per tick — `scrollBy` alone
     clamps to the laid-out window and degenerates into section turns).
- Output: `artifacts/e2e/<runId>/bench-results.json` (all samples +
  environment) and a stdout p50/p95/>32ms/>50ms summary, idle and drag
  reported separately.
- Gotchas, each of which cost time once:
  - Keep the window **unobstructed**: WebKitGTK suspends rAF for occluded
    views → zero frame samples.
  - The rAF sampler must register from an **8 ms** interval; a 16 ms tick
    beats against 16.7 ms frames and biases deltas to double intervals.
  - No named function bindings inside serialized `browser.execute`
    callbacks (transpiler `__name` helpers do not exist in the page realm)
    — see `pdfSurfaceMemory` in `e2e/specs/helpers.ts`.
  - Deliberately degraded environments (e.g. `WEBKIT_DISABLE_DMABUF_RENDERER=1`)
    can blow the suite's wait budgets and fail tests; the JSON report is
    still written and is the useful part.
  - Single-run medians vary with machine load (walk p50 ranged 41–116 ms
    across identical builds); for A/B conclusions, repeat runs and compare
    distributions, not single numbers.

## The measured record (Kubuntu Wayland, AMD + Mesa 26.0.8, 4K panel @ 60 Hz)

Reference geometry anomaly first: the maximized window reports
**2648×1389 CSS at devicePixelRatio 2 = 5296×2778 device px on a
3840×2160 panel** — geometrically impossible without compositor scaling or
an unfaithful dpr. See open questions.

| Scenario (maximized, dpr 2 unless noted) | idle p50/p95 (ms) | drag p50/p95 (ms) | render→blit p50/p95 (ms) |
| ---------------------------------------- | ----------------- | ----------------- | ------------------------ |
| Baseline (hard cap 2²⁵)                  | —                 | 43/47 · 44/50     | 55/218                   |
| Two-tier cap (2²⁴ soft, buffers halved)  | —                 | 43/49 · 43/50     | 78/266                   |
| + idle baseline in suite                 | 32/33 (both)      | 44/48 · 44/50     | 83/325                   |
| Window 1920×1080 (3840×2160 device)      | 32/33 (both)      | 32/34 · 32/35     | 48/234                   |
| 8 ms sampler (harness bias removed)      | 32/33 (both)      | 43/46 · 43/47     | 69/322                   |
| `WEBKIT_DISABLE_DMABUF_RENDERER=1`       | 32/111            | **129/166**       | **237/708**              |

Readings:

- Idle cadence is **32 ms everywhere** — half the display rate — across a
  2.8× physical-pixel range, idle vs scrolling, PDF vs EPUB, DMABUF on/off.
- Halving canvas buffer bytes (2²⁵ → 2²⁴) changed **nothing** in drag frame
  times; EPUB (no canvases) matches PDF exactly.
- Drag delta over idle is ~11 ms/frame in both formats.
- DMABUF-off makes everything dramatically worse (matches the Phase 0
  sanity check) — the fast path is active and must stay on (PERF-11).

## What is NOT the bottleneck (measured, don't re-chase)

- **Canvas buffer bytes at fit width** — halving them (A/B) did not move
  drag frame times.
- **The bitmap cache budget** (320 MB) — cache churn is not on the frame
  path.
- **Scroll event handling / React commits** — unchanged from the original
  investigation; still rAF-coalesced, state only on page change.
- **The GPU stack** — DMABUF off is 3–4× worse, so the accelerated path is
  engaged. AMD/Mesa is the well-supported configuration.

## Open questions

1. ~~**Why does the webview frame clock run at ~31 fps?**~~ **Answered
   2026-09-06** — WebKitGTK engine-level; see
   `docs/research/webview-frame-clock.md`. A bare GTK host (no Tauri/wry/app
   code) reproduces 32 ms idle / 43 ms damaged on both GTK3/WebKit 4.1 and
   GTK4/WebKit 6.0, Wayland and XWayland, GL and software compositing, while
   Firefox runs 60 Hz on the same session. Matches upstream
   [bug 315997](https://bugs.webkit.org/show_bug.cgi?id=315997)
   (DisplayRefreshMonitor timer fallback); confirming comment drafted in
   `docs/research/webkit-bug-315997-comment.md`. No app-side change can
   lift the ceiling. **2.53.92 is only a partial fix**: rAF reaches 60 Hz
   inside containers but still locks at ~31 fps natively (see
   `docs/research/webview-frame-clock.md` for the full A/B); re-test
   2.54.0 when it lands.
2. ~~**The dpr/geometry anomaly.**~~ **Answered 2026-09-06** — KDE
   fractional scaling 1.45 on DP-1 (3840×2160@60); non-fractional-aware
   clients get integer scale 2 and are compositor-downscaled (buffer
   fiction 1.90× vs native). No clamp implemented: at fit width the 2²⁴
   soft tier already yields ratio ≈ 1.37 < true 1.45 (bench-verified
   bufferPx 2²⁴), so the fiction costs ~nothing at reference conditions and
   the true scale is unknowable from inside the page. Details and decision
   rationale: `docs/research/webview-frame-clock.md`.
3. **PERF-2 calibration.** render→blit is wall-clock around a time-sliced
   raster on a main thread whose frame clock is capped by WebKitGTK (~31 fps
   idle / ~23 fps while damaging). Still uncalibrated until (1) is resolved
   upstream; re-measure before touching buffer sizes again.

## Candidate next levers (ordered)

1. **Confirm WebKit bug 315997 and track it** (open question 1, answered:
   engine-level). Upstream already has the root cause reported —
   [bug 315997, "DisplayRefreshMonitor falls back to Timer on Wayland,
   capping all WebKitGTK apps at ~30fps"](https://bugs.webkit.org/show_bug.cgi?id=315997)
   (NEW/P2, unconfirmed). Post the confirming comment prepared in
   `docs/research/webkit-bug-315997-comment.md`, tracked in
   [tuxbooks#3](https://github.com/tuunanet/tuxbooks/issues/3). Potential
   when fixed:
   ~2× on every smoothness metric; zero app code. Re-bench when a fixed
   WebKitGTK (post-2.52) reaches this machine.
2. ~~**Resolve the geometry anomaly**~~ — closed 2026-09-06 as a no-op;
   the soft render tier already sits below the true 1.45 scale at fit
   width (see the research doc before proposing any dpr override).
3. ~~**EPUB bounded measure**~~ — **implemented 2026-09-06** (PERF-12):
   scrolled flow caps the reading surface at 960 px inline (the paginator
   stretches its section iframe full-width in scrolled flow — ~2.7× the
   text column at maximized 4K); paginated keeps the engine's own grid cap.
   Verified: bench drag behavior identical (distance/wall unchanged, zero
   section jumps), frame times unchanged at the 31 fps clock (drag p50
   44–46 vs 42 baseline, within run variance — presentation-bound), with
   the width reduction as raster headroom for a fixed clock. See
   `docs/performance.md` PERF-12.
4. **Re-tier the render cap once the clock is fixed**: if drag delta over
   idle becomes the dominant term and still exceeds ~8 ms, revisit
   `MAX_RENDER_PIXELS` (the 2²⁴ tier) with the sharpness tradeoff made
   visually — at the 31 fps ceiling it was proven irrelevant to frames.
5. **PERF-2 re-measurement** after (1): if still > 100 ms p95 with a
   healthy clock, options are smaller soft-tier buffers or decoding/paint
   scheduling changes in `PdfPageCanvas`.

## Rules of engagement (unchanged)

- Budgets live in `docs/performance.md`; the fix for a violation is a fix,
  never a raised threshold. The two-tier cap kept PERF-1's hard 2²⁵
  invariant intact (unit-pinned).
- Timing is measured by `just bench-reader` or manual logging — never
  asserted in CI; E2E asserts deterministic `data-*` attributes only.
- The vendored foliate-js paginator is read through its public JS surface
  by the bench (closed shadow roots) but never modified (PERF-7).
- Fixture books for the bench are the user-provided real books under
  `tests/fixtures/books/EBooks/Agents/`; never replace them with
  copyrighted downloads.
