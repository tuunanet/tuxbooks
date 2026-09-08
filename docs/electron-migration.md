# Electron migration plan

Branch `web-reader-prototype-1` migrates the app from Tauri 2 + WebKitGTK +
foliate-js/PDF.js to **Electron + Readium (EPUB) + MuPDF.js/WASM (PDF)**.
The Rust core stays as a first-class native service. This doc is the
authority on migration phase status and the process/IPC design; other docs
describe the target contract.

## Status

| Phase | Scope                                                    | Status                                                                                                                                                                                                                                                                                                                      |
| ----- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Architecture inventory, progress-format inspection       | done                                                                                                                                                                                                                                                                                                                        |
| 1     | Electron shell + Rust sidecar bridge (library works)     | done — sidecar, shell, bridge, `tuxbooks://`, and the E2E suites all green on `@wdio/electron-service` 10.x + WebdriverIO 9.31 (service-managed chromedriver resolution with a deterministic repo fetcher, startup version record + driver sanity check, worker isolation gate); packaging (electron-builder) still pending |
| 2     | Format-agnostic `Reader` abstraction (`readerModel.ts`)  | planned                                                                                                                                                                                                                                                                                                                     |
| 3     | Readium EPUB reader + foliate→Readium progress migration | planned                                                                                                                                                                                                                                                                                                                     |
| 4     | MuPDF.js/WASM PDF reader                                 | planned                                                                                                                                                                                                                                                                                                                     |
| 5     | Remove Tauri/foliate/PDF.js remnants                     | planned — CI release pipeline guarded off                                                                                                                                                                                                                                                                                   |
| 6     | Performance pass + full validation                       | planned                                                                                                                                                                                                                                                                                                                     |

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
- Not yet done in phase 1: packaging (electron-builder; the CI release
  workflow is guarded off — `just test-e2e-release` covers the release
  sidecar path in the meantime), PDFium resource probing for packaged
  builds.

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
