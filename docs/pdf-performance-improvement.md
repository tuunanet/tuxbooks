# Handover: Make PDF Reading Start Immediately and Keep the Electron Reader Stable

**Repository:** `tuunanet/tuxbooks`
**Target branch:** `web-reader-prototype-1-e2e_playwright`
**Scope:** PDF reader open latency, first-page latency, scrolling/render performance, memory behavior, Electron/Chromium GPU-process stability
**Priority:** High
**Date:** 2026-09-09

---

## 1. Objective

The PDF reader must feel like a native desktop document viewer:

```text
User clicks PDF
        ↓
Reader shell appears immediately
        ↓
First readable page appears as soon as technically possible
        ↓
Current/next pages continue rendering in the background
        ↓
Scrolling remains responsive
        ↓
Heavy pages do not destabilize Electron
```

The target is not merely a better total load time.

The primary metric is:

> **time from opening a PDF until the first useful, readable page is visible.**

A 500-page PDF should not feel like the application is “opening a document” for several seconds before anything useful happens.

The second objective is stability:

> PDF rendering failures, GPU-process failures, worker failures, cancellation races, and heavy-page memory pressure must degrade gracefully rather than taking down the reader experience.

Do not sacrifice correctness, text selection, highlights, thumbnails, outlines, position restoration, or the existing bounded-render architecture merely to make one benchmark faster.

---

# 2. Current branch architecture

The branch has already migrated PDF rendering from the previous PDF.js/WebKitGTK setup to **MuPDF.js/WASM in a dedicated module worker**. Each PDF document owns a worker; MuPDF is lazily imported on first document open; rasterization happens inside the worker; rendered pages are returned as transferable `ImageBitmap`s.

The relevant architecture is:

```text
Electron main
    │
    ├── tuxbooks:// custom protocol
    │
    └── Rust sidecar
          │
          └── JSON-RPC over stdio

Renderer
    │
    ├── bridge.ts
    ├── usePdfDocument
    ├── PdfReader
    ├── virtualization
    ├── render scheduler
    ├── bitmap cache
    │
    └── pdfEngine.ts
            │
            └── MuPDF module worker
                    │
                    └── WASM
```

This overall separation is good and should remain.

The branch already has:

- worker-backed MuPDF rendering;
- bounded concurrent rendering;
- geometry-only slots for distant pages;
- bounded mounted canvases;
- offscreen rendering followed by an atomic visible-canvas blit;
- per-document bitmap LRU caching;
- cancellation checkpoints;
- lazy page geometry measurement;
- lazy text-layer creation;
- deterministic diagnostics and Playwright coverage.

Do **not** replace all of this with an uncontrolled “render everything” approach.

---

# 3. Primary diagnosis: the PDF is loaded completely before MuPDF opens it

This is the most important issue to fix first.

Current PDF opening is:

```ts
const bytes = await getBookBytes(bookId, "pdf");
loaded = await openPdfDocument(new Uint8Array(bytes));
```

`usePdfDocument` therefore waits for `getBookBytes()` to resolve before the MuPDF document even exists.

The bridge API explicitly returns an entire `ArrayBuffer`:

```ts
fetchBookBytes(bookId, format: string): Promise<ArrayBuffer>;
```

and:

```ts
getBookBytes(bookId, format);
```

returns the complete source file.

This means the current critical path is effectively:

```text
click PDF
   ↓
React reader mounts
   ↓
fetch entire PDF through tuxbooks bridge
   ↓
wait for entire ArrayBuffer
   ↓
transfer entire ArrayBuffer to worker
   ↓
lazy-import MuPDF
   ↓
download/instantiate WASM
   ↓
Document.openDocument(...)
   ↓
countPages()
   ↓
getPage(1)
   ↓
layout
   ↓
render page 1
   ↓
visible page
```

That is exactly the opposite of an “instant reader” architecture.

---

# 4. Important discovery: range support already exists

The infrastructure for range access is already present.

The Rust reader service has:

```rust
load_book_file_range(...)
```

which opens the PDF file, seeks to an offset, and reads only the requested range.

The JSON-RPC layer also already exposes:

```text
get_book_bytes
    book_id
    offset
    length
```

through `BookBytesArgs`.

The Electron `tuxbooks://book/<id>` handler already parses HTTP `Range` headers and translates them into:

```ts
sidecar.call("get_book_bytes", {
  bookId,
  offset,
  length,
});
```

It returns HTTP 206 responses with `Content-Range`.

So this is not a ground-up transport rewrite.

The current mismatch is:

```text
transport supports ranges
        BUT
PDF React opening path requests whole ArrayBuffer
```

Fix this before tuning canvas counts or React state.

---

# 5. First investigation: determine what MuPDF can consume incrementally

Do **not** assume that simply replacing:

```ts
fetch(...).arrayBuffer()
```

with a streaming `fetch()` is enough.

The current MuPDF integration calls:

```ts
Document.openDocument(view, "application/pdf");
```

with an in-memory byte array.

The official MuPDF.js documentation currently documents browser usage around fetching the PDF into an `ArrayBuffer` and passing that buffer to `Document.openDocument()`. It also documents a `Buffer` abstraction and page rendering, but do not assume that the browser build automatically performs HTTP-style incremental loading.

Therefore the agent must explicitly investigate the current `mupdf` package API rather than inventing a streaming API.

### Preferred architecture

If the installed MuPDF.js version exposes a supported file/stream abstraction capable of random-access reads:

```text
MuPDF document
      ↓
virtual seek/read adapter
      ↓
tuxbooks:// Range requests
      ↓
Rust seek/read
      ↓
local PDF file
```

implement that.

That would give the desired architecture:

```text
open PDF
   ↓
fetch only what MuPDF needs initially
   ↓
open document
   ↓
render page 1
   ↓
fetch more ranges only when needed
```

### If MuPDF.js cannot perform random-access streaming

Do **not** force a fake streaming implementation into the engine.

Instead benchmark two alternatives:

1. retain MuPDF.js but optimize the full-buffer path aggressively;
2. evaluate whether the native Rust side should expose PDF parsing/rendering through a file-backed native engine instead.

The second option is a larger architectural decision and should only happen after verifying that MuPDF.js fundamentally requires the full byte buffer for this use case.

The goal is not “streaming because streaming sounds good”; the goal is eliminating the full-file wait from the user-visible critical path.

---

# 6. Second major issue: MuPDF/WASM is cold-started on first PDF open

The worker currently imports MuPDF lazily:

```ts
mupdf = await import("mupdf");
```

and the WASM URL is resolved/configured at that point.

That is a sensible memory-saving policy, but it makes the first PDF open pay for:

```text
Worker startup
+
module load
+
WASM fetch
+
WASM compilation/instantiation
+
document open
```

This is especially visible because these costs occur before the first PDF page exists.

### Required optimization

Introduce **PDF engine prewarming** without opening a document.

Preferred behavior:

```text
Application/library screen starts
        ↓
renderer becomes idle
        ↓
prewarm MuPDF worker / WASM module
        ↓
user opens PDF
        ↓
worker already has MuPDF initialized
        ↓
document open starts immediately
```

The prewarm should:

- not open any real PDF;
- not allocate a full document;
- not rasterize pages;
- not block application/library startup;
- be cancellable;
- be disabled when the runtime lacks a usable worker environment.

A successful prewarm should be observable via diagnostics.

Do not make every PDF open slower by constructing unnecessary duplicate workers.

---

# 7. Third major optimization: make first paint intentionally cheaper than final-quality paint

Current rendering prefers:

```text
devicePixelRatio
```

subject to the pixel/dimension budget.

The render-policy implementation caps raster size, but at ordinary window sizes the effective ratio is often still the full device pixel ratio.

The current measured MuPDF raster performance is already above the intended budget:

```text
PERF-2 target: p95 <= 100 ms

Current re-baseline:
p50 147.5 ms
p95 176.5 ms
window 2643×1405
dpr 1.45
```

and the branch notes that MuPDF worker rasterization dominates this measurement.

Therefore an excellent perceived-performance strategy is:

```text
FIRST PAINT
ratio ≈ 1.0
     ↓
immediately readable page
     ↓
BACKGROUND REFINEMENT
ratio = normal effective dpr
     ↓
high-quality final page
```

For the first visible page only, consider a two-stage render:

```text
page 1:
    low-resolution fast render
        ↓
    atomic blit
        ↓
    user can read immediately
        ↓
    high-resolution background refinement
        ↓
    atomic replacement blit
```

This works particularly well with the existing architecture because the branch already renders into an offscreen buffer and only touches the visible canvas after the render has completed.

### Important

Do **not** show a partially painted canvas.

The invariant remains:

```text
either old/preview bitmap
or
complete new bitmap

never partially rendered visible state
```

The existing single-writer/offscreen design is valuable for stability and should be preserved.

---

# 8. First-page priority must dominate all secondary work

The first readable page is more important than:

- outline extraction;
- thumbnails;
- text-layer construction;
- search preparation;
- distant-page geometry correction;
- speculative rendering.

The worker is one serialized document engine. PDF rendering, text extraction and outline access all go through the same MuPDF worker.

Therefore opening should use explicit priority:

```text
P0:
    document open
    page 1 size
    first visible page preview render

P1:
    current page final-quality render
    immediately adjacent page

P2:
    one/preload page

P3:
    outline
    text-layer preparation
    thumbnails
    other non-critical work
```

In particular, do not let an outline request or thumbnail work occupy the worker ahead of page 1.

`getPdfOutline()` is currently kicked off as soon as the PDF document exists.

Change the scheduling so first-page rendering wins.

---

# 9. Keep thumbnails completely subordinate to main-page rendering

The branch already has a good thumbnail policy:

```text
MAX_THUMBNAIL_CANVASES = 12
MAX thumbnail renders in flight = 1
```

with the stated purpose of preventing thumbnail work from starving the reading page.

Preserve that principle.

During PDF opening:

```text
main reader > thumbnails
```

Always.

If the sidebar is open while a PDF starts:

```text
page 1
page 2
maybe page 3
        >
thumbnail generation
```

Never the reverse.

---

# 10. Do not render the PDF text layer on the critical path

The branch already delays text-layer creation until a page has rendered:

```tsx
{renderedPages.has(slot.pageNumber) && (
  <PdfPageTextLayer ... />
)}
```

and the text layer uses the worker to extract structured text before creating DOM spans.

Keep this separation.

However, after first paint, examine the cost of:

```text
MuPDF structured-text extraction
        +
JSON.parse
        +
many DOM span allocations
        +
layout/style calculation
```

The worker currently creates structured text JSON and then parses it:

```ts
JSON.parse(stext.asJSON());
```

before converting it to line objects.

For large text-heavy PDFs, this may cause substantial CPU and DOM work after rendering.

Potential optimization:

```text
first visible bitmap
        ↓
idle callback / lower-priority text extraction
        ↓
text layer
```

Do not make text selection unavailable forever; only move it out of the first-paint critical path.

---

# 11. The worker should become a priority-aware PDF scheduler

The current `WorkerClient` is essentially request/response based.

It does not currently know that:

```text
page 1 render
```

is more important than:

```text
outline
```

or:

```text
thumbnail page 23
```

Introduce a small scheduler above the raw worker protocol.

Conceptually:

```ts
type PdfTaskPriority =
  | "document-open"
  | "visible-page"
  | "adjacent-page"
  | "preload"
  | "text-layer"
  | "thumbnail"
  | "outline";
```

The scheduler should:

- maintain at most the intended number of active render operations;
- cancel obsolete low-priority work;
- promote the current anchor page immediately;
- never start a low-priority task when a newly visible page is waiting;
- preserve generation/document identity;
- distinguish cancellation from failure.

Do not simply raise:

```text
MAX_CONCURRENT_RENDERS
```

The branch already notes that MuPDF rasterizes synchronously inside one worker, so two in-flight requests do not mean two MuPDF renders are executing in parallel.

The useful optimization is **scheduling**, not blindly increasing concurrency.

---

# 12. Current raster path contains an avoidable pixel conversion chain

The worker currently does approximately:

```text
MuPDF pixmap
    ↓
pixmap.getPixels()
    ↓
Uint8ClampedArray
    ↓
ImageData
    ↓
createImageBitmap()
    ↓
transfer ImageBitmap
```

with an explicit pixel-buffer conversion before the bitmap is transferred.

This is a likely source of CPU/memory bandwidth cost.

The official MuPDF.js API documents that `Pixmap` exposes raw pixel data and can draw to Canvas, so investigate whether the installed version has a direct canvas/OffscreenCanvas rendering path that removes one or more conversions.

Profile before changing it.

The agent should compare at least:

```text
A. current:
Pixmap → getPixels → ImageData → ImageBitmap

B. direct canvas/offscreen-canvas path, if supported

C. alternative MuPDF-supported bitmap/image path
```

Measure:

```text
render CPU time
worker CPU time
main-thread CPU time
temporary allocations
peak RSS
time to visible bitmap
```

Do not change the path merely because it has “many copies”; prove that it materially contributes.

---

# 13. Cache policy is good; make it more useful for instant reopen

The current bitmap cache is a bounded LRU:

```text
320 MiB
8 entries
```

and retains rendered buffers for re-entry.

This is useful and should remain.

However, it is currently **per-document lifetime** and cleared when the reader/document goes away.

For an ebook reader, consider a second-level **small cross-session page-1 cache** only if profiling demonstrates that repeated reopening is common.

Do not persist full-page canvas bitmaps to disk.

A reasonable future architecture is:

```text
current-document cache
        ↓
largest performance benefit
        ↓
optional small memory-only recent-page cache
```

Do not introduce persistent raster caches before the open path and renderer are fixed.

---

# 14. Geometry should stay lazy

`usePdfGeometry` currently:

```text
gets page 1 dimensions
        ↓
estimates every page from page 1
        ↓
measures individual pages lazily
```

This is the correct general direction for a large continuous PDF document.

Do not change this into:

```text
measure all 500 pages before showing page 1
```

That would directly violate the instant-open objective.

If mixed-page geometry causes visible jumps, solve those locally with:

- better dimension prediction;
- better anchor compensation;
- batched nearby page measurement;

not complete upfront geometry scanning.

---

# 15. Do not confuse PDF-open latency with the existing `just dev` startup problem

The branch contains a separate startup-latency investigation concerning:

```text
just dev
```

and a possible ~30-second startup delay.

That is a different problem.

For this handover, measure two separate flows:

### A. App startup

```text
launch application
    ↓
window visible
```

### B. PDF open

```text
library already visible
    ↓
click PDF
    ↓
first readable page
```

The PDF optimization work must not hide behind improvements to `just dev`.

---

# 16. New PDF performance telemetry

Extend the existing deterministic PDF diagnostics.

The branch already exposes attributes such as:

```text
data-pdf-render-info
data-pdf-render-ms
data-pdf-bitmap-cache
data-render-state
```

and the performance documentation explicitly uses these for diagnosis.

Add a PDF-open timeline:

```text
data-pdf-open-state
data-pdf-open-ms
data-pdf-first-paint-ms
data-pdf-first-page
```

Prefer a state string such as:

```text
created
bytes-loading
document-opening
document-ready
geometry-ready
first-render-start
first-rendered
interactive
```

and a compact timing attribute:

```text
data-pdf-open-timing="
  bytes=...
  open=...
  page=...
  firstPaint=...
  interactive=...
"
```

Do not put fragile exact timing assertions into normal headless E2E tests.

The branch's own performance policy correctly treats timings as bench/manual measurements rather than deterministic CI assertions.

---

# 17. Add an explicit “first useful page” benchmark

The existing bench suite measures first-render latency, but the agent must make **first useful page** a first-class benchmark.

Measure:

```text
click-to-reader
click-to-document-open
click-to-page-geometry
click-to-first-preview
click-to-first-readable-page
click-to-final-quality-page
```

For example:

```text
PDF Open
  ├─ reader-shell visible          80 ms
  ├─ document ready               180 ms
  ├─ page 1 preview               230 ms
  ├─ page 1 final                 410 ms
  └─ page 2 ready                 550 ms
```

Exact thresholds should be measured on the development machine and representative hardware.

The key acceptance condition is qualitative:

> The user should be able to start reading page 1 before background PDF preparation has completed.

---

# 18. PDF test matrix

Benchmark at least:

### Small text PDF

```text
3–10 pages
mostly vector/text
```

### Large text PDF

```text
100+ pages
dense text
```

### Image-heavy PDF

```text
large raster images
full-page scans
```

### Large scanned document

```text
hundreds of pages
high-resolution page images
```

### Mixed-page-size PDF

Use the existing mixed-size fixture.

### Huge file size with relatively simple pages

This is especially important for testing whether full-file transport is currently dominating.

---

# 19. Measure transport separately from MuPDF

Add a controlled benchmark that measures:

```text
filesystem → Rust
Rust → Electron
Electron → renderer
renderer → worker
worker open
```

For the current implementation the path is approximately:

```text
disk
 ↓
tokio::fs::read
 ↓
Rust Vec<u8>
 ↓
base64 JSON
 ↓
Electron Buffer.from(base64)
 ↓
ArrayBuffer
 ↓
postMessage transfer
 ↓
MuPDF
```

The Electron protocol implementation currently base64-decodes range responses and whole-file responses because the Rust JSON-RPC boundary is text-based.

This is acceptable for small control/data operations but potentially expensive for multi-hundred-megabyte PDFs.

Do not redesign the entire JSON-RPC transport unless measurements show that this remains material after the range-backed/first-page architecture is implemented.

---

# 20. Longer-term transport optimization if necessary

If very large PDFs still show unacceptable transport costs after incremental loading is implemented, investigate a binary path.

Possible architectures:

```text
Option A
Electron custom protocol
        ↓
direct filesystem reads in main
```

or:

```text
Option B
Electron utility/native service
        ↓
random-access binary read API
```

or:

```text
Option C
native file-backed PDF renderer
```

Do not expose arbitrary filesystem paths to the renderer.

The current security model deliberately keeps paths on the main/native side and exposes only controlled `tuxbooks://` resources. Preserve that property.

---

# 21. GPU crash: treat it as an independent stability problem first

Observed developer log:

```text
ERROR:ui/gl/gl_fence_android_native_fence_sync.cc:65
eglDupNativeFenceFDANDROID duplication failure. Returned error=-1

ERROR:content/browser/gpu/gpu_process_host.cc:1035
GPU process exited unexpectedly: exit_code=133
```

This is clearly associated with Chromium's GPU process / EGL GPU-fence path, rather than being a MuPDF exception in the worker.

Chromium's current source contains the exact `eglDupNativeFenceFDANDROID` error logging path shown above.

Also, Chromium currently builds this GL-fence implementation for Linux/ChromeOS as well as Android-related configurations, so the presence of `ANDROID` in the source filename should not be treated as proof that the application is actually running on Android.

Most importantly:

> Do not conclude from this single log that PDF rendering is the root cause of the GPU crash.

The crash happened while the PDF was being interacted with, but correlation is not causation.

---

# 22. Instrument GPU and renderer process failures properly

Modern Electron exposes:

```text
app.on("child-process-gone", ...)
```

with details including:

```text
type
reason
exitCode
serviceName
name
```

and explicitly identifies `GPU` as a possible process type.

Electron also exposes:

```text
webContents.on("render-process-gone", ...)
```

for renderer process disappearance.

Add diagnostics for both.

For GPU:

```ts
app.on("child-process-gone", (_event, details) => {
  if (details.type !== "GPU") return;

  console.error(
    `[electron] GPU process gone reason=${details.reason} exitCode=${details.exitCode}`,
  );
});
```

For renderer:

```ts
window.webContents.on("render-process-gone", (_event, details) => {
  console.error(`[electron] renderer gone reason=${details.reason}`);
});
```

Record:

```text
timestamp
process type
reason
exit code
Electron version
Chromium version
OS
session/window state
whether PDF was open
PDF page
PDF render state
devicePixelRatio
GPU feature status
```

Electron also provides:

```text
app.getGPUFeatureStatus()
app.getGPUInfo()
app.isHardwareAccelerationEnabled()
```

for GPU diagnostics.

Capture these in development diagnostics and failure artifacts.

---

# 23. Do not disable GPU yet

The project's existing performance policy explicitly says:

```text
no GPU workaround without evidence
```

and the Electron migration document similarly treats GPU/compositor behavior as something to measure rather than blindly work around.

Therefore:

**Do not immediately add:**

```text
--disable-gpu
app.disableHardwareAcceleration()
```

or arbitrary X11/Wayland switches to shipping code.

Electron documents `app.disableHardwareAcceleration()` as a global application setting that must happen before the app is ready.

Turning it off might hide the crash while simultaneously destroying the performance characteristics of the PDF reader.

First establish:

```text
Does the crash reproduce?
Does it reproduce only on Wayland?
Does it reproduce only with GPU acceleration?
Does it reproduce only during PDF rasterization?
Does it reproduce with thumbnails disabled?
Does it reproduce with page rendering disabled?
Does it reproduce on an image-heavy PDF?
Does it reproduce with an ordinary web page?
```

---

# 24. Very important platform-testing discrepancy

The Playwright Electron fixture currently launches E2E with:

```text
--no-sandbox
--ozone-platform=x11
```

and optionally forces device scale factor.

Therefore the normal E2E suite is deliberately not testing the same Linux/Wayland path that may be producing the developer's GPU crash.

This matters.

Add a separate headed/manual stability configuration for:

```text
native Wayland
```

and compare it against:

```text
X11
```

Do not silently change the existing deterministic CI setup just to make it match.

The goal is to have both:

```text
CI deterministic X11 coverage
+
real desktop Wayland stability coverage
```

---

# 25. GPU crash recovery behavior

A GPU process disappearing does not necessarily mean the application must exit.

Electron explicitly exposes the GPU child-process lifecycle separately from renderer-process lifecycle.

The agent should verify Chromium's actual recovery behavior on the target Electron version.

The desired behavior is:

```text
GPU crash
   ↓
Chromium attempts normal GPU recovery
   ↓
reader stays alive
   ↓
current page remains usable or rerenders
```

If the renderer itself dies:

```text
renderer process gone
   ↓
reader detects invalid state
   ↓
controlled reload/recovery
   ↓
saved reading position restored
```

Do not blindly call `reload()` from a GPU-process event. The renderer may still be perfectly healthy.

---

# 26. Add a controlled renderer-recovery state

The PDF reader should not assume:

```text
document != null
```

means the Electron renderer/process remains healthy indefinitely.

Introduce a recoverable state boundary:

```text
PDF_LOADING
PDF_READY
PDF_DEGRADED
PDF_ERROR
```

where `PDF_DEGRADED` can represent:

- worker lost;
- a page render repeatedly failed;
- renderer recovered after a process-level event;
- GPU fallback occurred.

The user-facing behavior should be controlled and localized.

A single page failure already has a Retry path. Preserve that model: a bad page must not poison the entire reader.

---

# 27. Improve worker failure recovery

Current `WorkerClient.worker.onerror` rejects all pending requests, but the worker is then effectively dead.

Strengthen this.

On worker failure:

```text
worker error
   ↓
mark PDF worker unavailable
   ↓
cancel pending render tasks
   ↓
discard invalid document handle
   ↓
create replacement worker
   ↓
re-open document
   ↓
restore current page
   ↓
render current page
```

For this to work reliably, the document source must be reopenable without relying on the consumed/transferred original `ArrayBuffer`.

This is another reason to move toward a file-backed/range-backed source abstraction.

---

# 28. Cancellation must remain normal control flow

The branch correctly distinguishes:

```text
PdfRenderCancelledError
```

from actual failures.

Preserve that.

Rapid:

```text
page 1
→ page 40
→ page 12
→ page 88
→ page 13
```

must not create a stream of alarming errors.

Cancellation is:

```text
expected
cheap
silent
```

while:

```text
worker crash
invalid PDF
MuPDF exception
GPU crash
out-of-memory
```

are diagnostic failures.

---

# 29. Memory stability: pay special attention to image-heavy PDFs

The current render buffer policy is deliberately pixel/byte based, with:

```text
MAX_ACTIVE_CANVAS_BYTES = 256 MiB
bitmap cache = 320 MiB
```

and hard per-page render caps.

The branch is therefore already much safer than an “all pages remain rendered” implementation.

However, the actual temporary memory during rendering is larger than the final canvas alone:

```text
MuPDF WASM heap
+
MuPDF pixmap
+
JS typed-array view/copy
+
ImageData
+
ImageBitmap
+
offscreen Canvas
+
visible Canvas
+
bitmap cache
```

That is important.

A page can temporarily consume substantially more memory than:

```text
width × height × 4
```

during conversion.

The agent should measure peak RSS / process memory during:

```text
large page render
rapid scrolling
zoom
cache churn
GPU crash/recovery
```

Do not assume that the canvas byte budget is equivalent to total process memory.

---

# 30. Avoid simultaneous high-DPI rerasterization storms

Zoom currently invalidates cached bitmaps and triggers rerendering. The existing E2E specifically tests zoom churn.

Ensure:

```text
zoom 100 → 150 → 200 → 100
```

does not create:

```text
multiple obsolete huge WASM pixmaps
+
multiple ImageBitmaps
+
multiple queued pages
```

at once.

For zoom changes:

1. cancel obsolete low-priority renders;
2. render current anchor page first;
3. use a preview-quality ratio if necessary;
4. progressively refine;
5. drop obsolete buffers aggressively.

---

# 31. Do not make React responsible for the render scheduler

React should own:

```text
reader state
page state
zoom state
selection state
```

but not become the queue itself.

Avoid designs like:

```text
setState(...)
setState(...)
setState(...)
```

for every raster task.

The actual PDF scheduler should be imperative/worker-oriented.

React should receive relatively coarse events:

```text
page 1 rendered
page 2 rendered
page failed
worker failed
```

The existing performance budget explicitly limits scrolling-related React commits.

---

# 32. Do not destroy the whole reader on every page render

The existing architecture uses a stable document handle plus lightweight slots.

Preserve:

```text
one PdfDocument
many geometry slots
bounded render set
```

Avoid recreating:

```text
MuPDF document
worker
PDF byte buffer
```

for every page.

Only the document itself should own the engine lifetime.

---

# 33. First implementation milestone

The first coding milestone should be:

## “First readable page without waiting for the entire PDF”

The agent should prove one of:

### Preferred

```text
MuPDF file/stream adapter
+
tuxbooks:// Range
```

or:

### Fallback

A measured architecture that significantly reduces the cost of preparing the complete byte buffer while still preserving the current engine.

Acceptance:

```text
large PDF
click
first readable page
```

must occur before all non-critical document preparation has completed.

Do not start by changing:

```text
MAX_ACTIVE_CANVASES
MAX_CONCURRENT_RENDERS
bitmap-cache size
```

Those are secondary.

---

# 34. Second implementation milestone

## “Warm PDF engine”

Add:

```text
MuPDF worker prewarm
```

and measure:

```text
cold PDF open
warm PDF open
```

The difference should be visible in the telemetry.

The prewarm must not visibly delay library startup.

---

# 35. Third implementation milestone

## “Two-stage first-page raster”

Implement:

```text
preview render
    ↓
first paint
    ↓
final-quality render
```

for the page the user is currently reading.

The first preview must be:

- readable;
- complete;
- stable;
- atomic;
- cancellable.

---

# 36. Fourth implementation milestone

## “Priority-aware rendering”

Guarantee:

```text
current page
>
adjacent visible page
>
one preload page
>
text layer
>
outline
>
thumbnails
>
distant work
```

and verify under rapid scrolling.

---

# 37. Fifth implementation milestone

## “Electron process diagnostics”

Add:

```text
GPU child-process-gone
renderer render-process-gone
GPU feature information
renderer responsiveness
worker failure
```

to dev diagnostics.

Build a repeatable reproduction matrix for:

```text
Wayland
X11
GPU enabled
GPU disabled
small PDF
large PDF
image-heavy PDF
rapid scroll
zoom
thumbnail sidebar
```

GPU disabling is a **diagnostic experiment**, not the final fix.

---

# 38. Sixth implementation milestone

## “Recovery”

Verify:

```text
PDF worker failure
    ↓
document reopens
    ↓
current page restored
    ↓
reader remains usable
```

and separately:

```text
GPU process restart
    ↓
reader remains alive
```

and:

```text
renderer crash
    ↓
controlled renderer recovery
    ↓
reading position restored
```

Only implement recovery behavior appropriate to the actual failure mode.

---

# 39. Playwright requirements

Add deterministic E2E coverage for state rather than timing.

### Required assertions

After opening a large PDF:

```text
pdf reader exists
document state becomes ready
page 1 eventually rendered
page canvas is non-blank
render set stays bounded
```

Add:

```text
data-pdf-open-state
data-pdf-first-page
data-pdf-render-info
data-pdf-bitmap-cache
```

assertions.

### Add a first-paint benchmark

The benchmark should capture:

```text
click timestamp
first-preview timestamp
first-readable timestamp
final-quality timestamp
```

but timing thresholds remain outside normal headless CI.

### Add stress cases

```text
open large image PDF
rapid page jumps
zoom churn
sidebar open
scroll oscillation
return to previous page
```

The existing suite already has rapid-scroll, cache, zoom, mixed-size, outline, and reading-position tests. Extend it rather than replacing it.

---

# 40. Manual benchmark protocol

Use the existing:

```bash
just bench-reader
```

and collect before/after:

```text
first render
first useful page
page render p50
page render p95
page render max
page-walk frame intervals
dropped frames
live canvas memory
bitmap cache occupancy
```

The current performance document already defines this benchmark flow and explicitly records the current MuPDF p95 of 176.5 ms at the measured non-reference viewport.

Do not “fix” PERF-2 by simply changing:

```text
p95 <= 100 ms
```

to:

```text
p95 <= 200 ms
```

The required response to a regression is optimization or a documented reason based on measured evidence.

---

# 41. Required performance invariants

These must remain true after the work:

```text
1. No entire-document DOM rasterization.

2. No unbounded PDF bitmap cache.

3. No unbounded simultaneous render queue.

4. Current-page render always has priority.

5. Visible canvas is never partially painted.

6. Render cancellation is normal control flow.

7. Worker failures do not silently poison a session.

8. Text extraction does not block first paint.

9. Outline loading does not block first paint.

10. Thumbnail work never starves the main page.

11. Per-page raster dimensions remain budgeted.

12. Scroll handlers remain rAF-coalesced.

13. No per-frame Electron main-process IPC.

14. No GPU workaround is shipped without measured evidence.

15. Existing reading-position semantics remain unchanged.
```

---

# 42. Files that should be the first investigation targets

Start here:

```text
frontend/src/components/reader/pdf/hooks/usePdfDocument.ts
frontend/src/lib/bridge.ts
electron/main/index.ts
src-tauri/src/services/reader.rs
src-tauri/src/rpc.rs

frontend/src/lib/pdf/pdfEngine.ts
frontend/src/lib/pdf/mupdfWorker.ts

frontend/src/components/reader/pdf/PdfReader.tsx
frontend/src/components/reader/pdf/PdfPageCanvas.tsx
frontend/src/components/reader/pdf/PdfPageTextLayer.tsx

frontend/src/components/reader/pdf/hooks/usePdfVirtualization.ts
frontend/src/components/reader/pdf/pdfRenderPolicy.ts
frontend/src/components/reader/pdf/pdfBitmapCache.ts

docs/pdf.md
docs/performance.md
docs/electron-migration.md

e2e/specs/pdf-reader.e2e.ts
e2e/fixtures/electron-app.ts
```

The existing implementation confirms that `usePdfDocument` is the current beginning of the PDF-open critical path, while `pdfEngine`/`mupdfWorker` define the engine boundary.

---

# 43. Agent workflow

Execute in this exact order:

```text
1. Reproduce PDF-open latency with an existing small PDF.
2. Reproduce with the largest available PDF.
3. Add PDF-open timing telemetry.
4. Measure:
      click
      getBookBytes start/end
      MuPDF worker start
      WASM load
      Document.openDocument
      getPage(1)
      first render start
      first bitmap
      first visible paint

5. Confirm whether full-file transport dominates.
6. Inspect MuPDF.js random-access/streaming capabilities.
7. Implement file-backed/range-backed opening if supported.
8. Otherwise optimize the current full-buffer path and document the limitation.
9. Add MuPDF prewarming.
10. Add first-page preview rendering.
11. Add priority-aware rendering.
12. Move outline/text/thumb work below first paint.
13. Profile the Pixmap → ImageData → ImageBitmap conversion.
14. Re-run performance benchmarks.
15. Add Electron GPU/renderer process diagnostics.
16. Reproduce the GPU crash on native Wayland.
17. Compare Wayland vs X11.
18. Determine whether PDF rendering materially correlates with the GPU failure.
19. Add appropriate worker/renderer recovery.
20. Run all PDF E2E tests.
21. Run headed benchmark/stability tests.
22. Only then consider deeper Electron GPU changes.
```

---

# 44. Acceptance criteria

The work is complete only when:

### Instant PDF opening

- Clicking a PDF no longer waits unnecessarily for the entire document before useful content can appear.
- A large PDF can begin displaying its first readable page while non-critical work is still occurring.
- PDF engine/WASM cold-start cost is measured and, where useful, prewarmed.
- First-page rendering has explicit priority.

### Rendering

- First visible page can use a faster preview-quality raster when necessary.
- Final-quality refinement happens without visible tearing or partial rendering.
- Existing pixel and memory budgets remain enforced.
- Rapid scrolling continues to converge on the correct page.
- Cached pages still reappear without unnecessary rerasterization.

### Stability

- MuPDF worker failure is distinguishable from normal render cancellation.
- A failed page remains an isolated page failure.
- GPU-process failure is logged with Electron's process diagnostics.
- Renderer-process failure is logged separately.
- The exact GPU crash is tested on the actual Wayland environment.
- No blanket `--disable-gpu` workaround is introduced without evidence.
- The reader can recover from a recoverable worker/renderer failure while preserving the reading position.

### Regression protection

- Existing PDF Playwright tests pass.
- Large-document virtualization remains bounded.
- Thumbnail rendering remains subordinate to page rendering.
- Search, outline, highlights, selection, zoom, persistence and mixed-page geometry remain functional.
- `just check` and the relevant E2E suites remain green.
- Performance benchmarks are compared against the existing Chromium/MuPDF baseline rather than silently replacing the target.

---

# 45. Most important conclusion

The current branch already contains substantial work to solve **steady-state PDF rendering**:

```text
virtualization
+
bounded canvases
+
render cancellation
+
offscreen atomic blits
+
bitmap caching
+
pixel/byte budgets
```

The biggest remaining problem is earlier:

```text
PDF click
   ↓
WAIT FOR ENTIRE PDF
   ↓
START MU​PDF
   ↓
START RENDERING
```

The next architecture should instead aim for:

```text
PDF click
   ↓
fast resource access
   ↓
MuPDF already warm
   ↓
document available
   ↓
P1 preview render
   ↓
FIRST READABLE PAGE
   ↓
background final-quality render
   ↓
adjacent pages
   ↓
text / outline / thumbnails
```

That is the change most likely to transform TuxBooks from “PDF reader that eventually opens” into “PDF reader that feels immediate.”
