# Handover: dev startup latency

Point-in-time handover for the `just dev` startup-latency investigation
(branch `web-reader-prototype-1`, 2026-09-09). The fix it describes landed in
`3f294c1`; if this doc is still around later, check whether its open items
below are already resolved.

## Problem

Running `just dev`, the terminal sat on Vite's "ready" line for a long time
before `tuxbooks service ready` appeared and the window opened. The reporter
runs a 4K display (dpr ~1.45) on Wayland; no numbers were captured for the
original slow run.

The boot path is: `just dev` → cargo build (debug sidecar, cached) →
esbuild bundles → Vite dev server (port 1420) → Electron spawn →
`app.whenReady()` → sidecar spawn + health check (ping) → `createWindow` →
renderer loadURL → Vite transforms the app → React mounts →
`[boot] renderer mounted`.

## Results

### Where the time actually sat

Segment instrumentation (added in `3f294c1`, always on, one line per segment
in the terminal):

```
[startup] app ready +<ms>          — Electron process init
[startup] sidecar healthy +<ms>    — sidecar spawn + DB pool + watcher registration
[startup] renderer mounted +<ms>   — cumulative: + Vite transform + React mount
```

Measured on the investigation machine (Linux, xvfb where headless; the
31-book real-world fixture tree under `tests/fixtures/books/EBooks`):

| Segment                                                 | Measured | Notes                                                                                     |
| ------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| Electron init (spawn → `app ready`)                     | ~100 ms  | not the bottleneck                                                                        |
| Sidecar healthy, dev path (unchanged library)           | 21 ms ×3 | identical before/after the fix — an unchanged library never was the blocker either        |
| Sidecar healthy, seeded path (fresh DB, 31-book import) | 3.5 s    | synchronous by contract: E2E needs the books present at the first `list_books` (E2E-only) |
| Renderer first mount (Vite transform + React boot)      | ~1.5 s   | the dominant fixed dev-mode cost; production loads a prebuilt ~0.5 MB bundle instead      |
| One-time Vite dep re-optimization                       | ~90 s    | observed once after the pdfjs→mupdf dependency swap; cached since, recurs on dep changes  |

### Root cause fixed in `3f294c1`

The window only opens after the sidecar is healthy (deliberate: the
renderer's first invokes need the method table, and watcher registration
must not lag the UI — a file added in that window went unseen). But the
sidecar ran its **entire startup reconciliation** (parse + PDFium cover
extraction for every changed/new file) and the artwork-cache sweep _inside_
init, before the ping health check could pass. One changed book delayed the
whole app start by its full import cost.

Fix: `init_state` still registers the pool, watchers, and watched locations
synchronously; the reconciliation walk and the cover sweep now run in a
spawned tokio task after `service ready`, ordered walk-then-sweep so an
in-flight import's cover file is never raced by the GC. Catch-up results
reach the UI live via `library-changed` events, which the library view
already consumes.

## Remaining latency and potential fixes

1. **Renderer first mount in dev (~1.5 s, larger on cold caches / slower
   disks).** Vite transforms ~2.3k modules on first load. Potential:
   `server.warmup` for the entry modules, or trimming the entry chunk
   (reader engines already lazy-load). Assessment: dev-only cost, bounded;
   not worth complexity unless the segment log shows it growing.

2. **Electron init on the reporter's machine (unquantified).** If their
   `[startup] app ready` stamp is large (4K + Wayland GPU probe, fontconfig
   cold start), there is no app-side fix without data — PERF-11 forbids GPU
   workarounds without a written cause. Next step: collect the three stamps
   from a real `just dev` run on the affected machine and decide.

3. **Startup catch-up with many changed books.** Already off the critical
   path (background). Potential if it ever matters: log a one-line catch-up
   summary (imported/updated/failed) when the background walk finishes, so
   a slow first-minute import is visible in the terminal.

4. **Seeded E2E path (3.5 s synchronous import).** Could be deferred like
   the dev path, but E2E correctness depends on the seeded books existing
   at the first `list_books`; deferring would need the E2E harness to await
   readiness. Assessment: don't — the import is the seed.

5. **One-time Vite re-optimization (~90 s) after dependency changes.**
   Inherent to `pnpm install` + lockfile churn; warm afterwards. Potential:
   document it (done here) rather than work around it.

## How to verify

```sh
just dev
```

Read the three `[startup]` stamps. Expected healthy shape: `app ready`
≈ instant, `sidecar healthy` well under 500 ms even right after adding
books to the library, `renderer mounted` a couple of seconds in dev. The
sidecar binary alone (dev path) can be re-measured headlessly:

```sh
cargo build --manifest-path src-tauri/Cargo.toml
TEST_DATABASE_PATH=/tmp/t.db timeout 5 src-tauri/target/debug/tuxbooks </dev/null
```

`service ready` on stderr is the health-check moment; regression means it
moved back behind the library walk. Rust tests, seeded/empty E2E, and
clippy were green on `3f294c1`.
