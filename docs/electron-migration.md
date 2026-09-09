# Electron migration plan

Branch `web-reader-prototype-1` migrates the app from Tauri 2 + WebKitGTK +
foliate-js/PDF.js to **Electron + Readium (EPUB) + MuPDF.js/WASM (PDF)**.
The Rust core stays as a first-class native service. This doc is the
authority on migration phase status and the process/IPC design; other docs
describe the target contract.

## Status

| Phase | Scope                                                    | Status                                                                                                                                                                                                                                                                                  |
| ----- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Architecture inventory, progress-format inspection       | done                                                                                                                                                                                                                                                                                    |
| 1     | Electron shell + Rust sidecar bridge (library works)     | done — sidecar, shell, bridge, `tuxbooks://`, Playwright E2E, and electron-builder packaging                                                                                                                                                                                            |
| 2     | Format-agnostic `Reader` abstraction (`readerModel.ts`)  | done — landed in `f30fc85`                                                                                                                                                                                                                                                              |
| 3     | Readium EPUB reader + foliate→Readium progress migration | done — landed in `f30fc85`, with migration `0009` and versioned/idempotent adapter                                                                                                                                                                                                      |
| 4     | MuPDF.js/WASM PDF reader                                 | done — worker-backed MuPDF rendering, structured-text selection/search, outline, virtualization, and HiDPI E2E                                                                                                                                                                          |
| 5     | Remove Tauri/foliate/PDF.js remnants                     | done — removed submodule/config/runtime wiring; electron-builder deb/rpm/AppImage packaging + CI release pipeline                                                                                                                                                                       |
| 6     | Performance pass + full validation                       | done — deterministic budget gates (PERF-1/3/4 unit tests, hidpi E2E) + `just check` + empty/seeded/release E2E; Chromium/MuPDF re-baseline recorded in docs/performance.md PERF-2 (p95 176.5 ms at 2643×1405 dpr 1.45; true-reference dpr-1/2 enforcement pending a bench dpr override) |

Update this table as phases land.

### Phase 1 decisions and state (2026-09-07)

- The Rust crate stays `tuxbooks` in `src-tauri/` (rename is cosmetic churn;
  the binary is now the sidecar). `commands/` became tauri-free service-call
  functions; `rpc.rs` holds the JSON-RPC method table (one method per former
  Tauri command, same camelCase DTOs).
- Wire format: newline-delimited JSON over stdio. Requests
  `{jsonrpc, id, method, params}`; events arrive as notifications
  `{jsonrpc, method: "event", params: {name, payload}}`. `ping` is the
  health check. Book bytes are base64 inside `get_book_bytes` responses
  (`{data, offset, total}`) — the renderer normally fetches through the
  `tuxbooks://` protocol instead, which supports HTTP-style ranges.
- The renderer's entire outside world is `window.tuxbooks`
  (`electron/preload/preload.ts`, enumerated): `invoke`, `onEvent`,
  the four pickers, `revealInFileManager`, `fetchBookBytes` (protocol
  fetch), and `pathForFile` (webUtils — File.path no longer exists).
  `frontend/src/lib/bridge.ts` is the only consumer.
- `tuxbooks://` privileges: `standard, secure, supportFetchAPI, corsEnabled,
stream`. corsEnabled is load-bearing — Chromium refuses cross-origin
  fetch() to a non-CORS-enabled scheme before the handler runs (found by
  the boot probe). Handler responses carry `access-control-allow-origin`.
- Sidecar logs go to stderr; stdout is the JSON-RPC channel only.
- Frontend tests fake `window.tuxbooks` (`frontend/tests/mocks/bridge.ts`,
  installed on import) — no vi.mock hoisting needed anymore.
- Drag-and-drop import uses DOM drag events + `pathForFile`; the Tauri
  webview drag-drop events are gone.
- Boot diagnostics (dev only): main logs `[boot] renderer mounted` or a
  loud failure; `TUXBOOKS_BOOT_PROBE=1` fetches book 1 through the
  protocol; `TUXBOOKS_DEBUG_IPC=1` logs bridge calls and protocol hits.
- Packaging and packaged PDFium probing landed in phase 5: electron-builder
  places the release sidecar and `libpdfium.so` together in
  `resources/sidecar`; `just package`, `just check-deb`, and the tag release
  workflow are the shipping path.

### Phase 4 decisions and state (2026-09-09)

- MuPDF.js 1.28.x (`mupdf` npm) behind `lib/pdf/pdfEngine.ts`. A
  per-document module worker (`mupdfWorker.ts`) owns every engine object —
  MuPDF rasterizes synchronously, so the worker keeps it off the UI thread;
  closing the document terminates the worker and frees the WASM heap.
  Renders transfer an `ImageBitmap`; outline pages arrive 0-based and are
  normalized to 1-based in `pdfOutline.ts`.
- The WASM bundle ships through a small Vite plugin
  (`virtual:mupdf-wasm-url`): the emscripten glue's chunk-relative
  resolution never finds the asset in a bundled build, so the main thread
  resolves the URL and the worker pins it as `Module.locateFile` before the
  dynamic import. The worker chunk needs `worker.format: "es"`.
- Page-geometry seam keeps the old viewport shape (`getViewport({scale})`,
  render transform ratio), so layout, virtualization, and cache policy
  carried over unchanged. Served `.wasm` responses need
  `application/wasm` MIME in the `app://` handler table.

### Phase 5 removals and packaging (2026-09-09)

- Removed: the foliate-js submodule (with `.gitmodules` and its vendored
  pdfjs copy), `tauri.conf.json`, capabilities/gen, the WebKitGTK dev-env
  plumbing (`scripts/dev-env.sh`), the `setup-tauri-deps` action, the
  release workflow's migration-guard job, and the Tauri icon tree.
- Packaging: electron-builder (`electron-builder.yml`) with
  `just package` / `just check-deb`; sidecar binary + `libpdfium.so` ship
  together in `resources/sidecar`. CI's build job runs the deb target +
  gate on every push; the release workflow builds and gates the published
  deb + AppImage (rpm stays a local target — it needs rpmbuild).
- Kept: the `src-tauri/` crate name/path (phase-1 decision), PDFium
  import-time covers (decision recorded in docs/pdf.md), and the foliate
  references inside the progress-migration fixtures/tests (intentional:
  they pin user-data compatibility).

### Phase 6 state (2026-09-09)

- UAT-found EPUB surface bug: the toolkit mounts
  `.readium-navigator-iframe` with `position: absolute` but no dimensions —
  sizing it is host-app work. `readiumEngine.css` fills the navigator
  container; a new geometry assertion in `epub-reader.e2e.ts` pins it (a
  lost stylesheet renders the book as a 300×150 top-left block while every
  state attribute stays honest).
- Bench harness: maximize tolerance widened for WM title-bar decorations
  (a stable ~28 px shortfall on GNOME).
- Chromium/MuPDF performance re-baseline recorded in docs/performance.md
  (PERF-2); deterministic budget gates all hold.

## Target process model

```
Electron
├── main process (electron/main/)
│     ├── window lifecycle, dialogs/shell
│     ├── tuxbooks:// custom protocol (book bytes, covers, EPUB resources)
│     └── spawns + proxies the Rust sidecar
│           └── JSON-RPC over stdio
├── preload (electron/preload/) — contextIsolation on, sandbox on,
│     nodeIntegration off; exposes enumerated window.tuxbooks only
└── renderer (frontend/) — React + Vite, Chromium
      ├── bridge: src/lib/bridge.ts (the only window.tuxbooks consumer)
      ├── Readium TS Toolkit → EPUB (lib/epub/readiumEngine.ts)
      └── MuPDF.js/WASM → PDF (lib/pdf/pdfEngine.ts)
```

## Rust service (sidecar)

- `src-tauri/` becomes a standalone service binary (crate rename TBD at
  implementation). No Tauri crate. `domain/`, `epub/`, `pdf/`, `db/`,
  `repository/`, `services/` carry over unchanged in responsibility.
- The old Tauri `commands/` layer becomes the JSON-RPC method table: one
  method per existing command, identical DTOs (camelCase preserved).
- Event push (`library-changed`, `import-progress`) becomes JSON-RPC
  notifications on the same stdio channel.
- Lifecycle: spawned by main at startup, health-checked (ping method),
  restarted on unexpected exit, killed on app quit. Must survive renderer
  reloads (it is owned by main, not the renderer).
- `TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH` overrides keep working — the
  sidecar inherits main's environment.

## Resource protocol

Book bytes, covers, and EPUB resources load through the scoped
`tuxbooks://` custom protocol registered in main (privileges granted to the
app's own origin only; range requests supported for large files). Paths
never cross into the renderer. No arbitrary local HTTP server.

## Reading-progress migration (user data, must survive)

Stored progress is TuxBooks user data; foliate and Readium are rendering
engines, and the stored row is engine-independent plus engine metadata:

```
ReadingProgress: bookId, locator, progression, locations, updatedAt,
                 schemaVersion, engine
```

- Inspect the existing persistence format (migration `0004`:
  `cfi` + `chapter_href` + `progress_percent`) before writing the adapter;
  do not assume foliate and Readium CFIs are interchangeable.
- Adapter converts foliate locators to Readium locators, validated against
  the actual EPUB; idempotent and versioned; original data preserved until
  validated; per-book completion marker.
- Fallback hierarchy: exact location → CFI → spine+element/offset →
  spine+progression → book percentage → beginning. Never silently jump to
  the beginning when a better fallback exists.
- Preserve the logical reading position, never the old visual page number.

## Removal checklist (phase 5)

Tauri config/plugins, `@tauri-apps/*`, `@wdio/tauri-plugin`,
`tauri-driver`/WebKitWebDriver wiring, vendored `foliate-js` submodule,
`pdfjs-dist`, `fetch-pdfium.sh` (if MuPDF covers covers), `custom-protocol`
feature, webkit2gtk env plumbing, and stale justfile targets. Repo-wide
sweep for `tauri|foliate|webkit` residue before declaring done.
