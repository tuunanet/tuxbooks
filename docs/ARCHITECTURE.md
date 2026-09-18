# Architecture

tuxbooks is a local-first desktop ebook library manager. There is no backend
server, no cloud sync, and no network dependency: Chromium (via Electron) is
the sole desktop web runtime; a native Rust service owns the database and
the filesystem; Readium and MuPDF.js render books.

**Migration state:** the Electron migration is complete; this doc
describes the current contract.

## Process and boundary

```
┌───────────────────────────────── Electron ──────────────────────────┐
│  Renderer (frontend/)              Main process (electron/main/)    │
│  React + TypeScript + Vite         window, dialogs/shell            │
│                                    ├─ tuxbooks:// protocol handler  │
│  window.tuxbooks (preload) ─────►  ├─ spawns + proxies the Rust     │
│  typed Promise result  ◄─────────  │   sidecar (JSON-RPC, stdio)    │
│                                    └─ resource byte serving         │
│                                                                     │
│  Rust sidecar (native service)                                      │
│  ├─ services/ (application ops)    ├─ repository/ (SQL)             │
│  ├─ worker/ (worker client,        ├─ db/ (SQLite + migrations)     │
│  │  proto, sandbox)                │                                │
│  └─ spawns per parse job ─────►    tuxbooks-worker (one-shot)       │
│                                    ├─ epub/ + pdf/ (parsing)        │
│                                    └─ Landlock + seccomp + rlimits  │
└─────────────────────────────────────────────────────────────────────┘
```

- The renderer never touches Node.js (`nodeIntegration: false`),
  SQL, the filesystem, or ZIP archives. `electron/preload/` exposes a
  minimal, explicitly enumerated `window.tuxbooks`; the renderer's only
  consumer is `lib/bridge.ts`.
- The main process owns plumbing only: window lifecycle, dialogs/shell,
  the `tuxbooks://` protocol, sidecar spawn/health/restart/teardown, and
  the GPU-crash fallback (`docs/gpu-fallback.md`) — the one place a
  Chromium GPU flag is set, and only on recorded cause. No business logic.
- The Rust sidecar never renders UI. Its method table only translates
  JSON-RPC payloads into service calls.
- Book bytes, covers, and EPUB resources flow through the scoped
  `tuxbooks://` custom protocol (range requests supported, granted to the
  app's origin only) — never an arbitrary local HTTP server; paths never
  cross into the renderer.

### Renderer-facing boundary (issue #84, invariants T-1..T-7)

The Chromium-facing boundary is enforced in four modules, all unit-tested
in `frontend/tests/security/`:

- `electron/shared/pathSchema.ts` — the validated path/query schema shared
  by main, preload, and tests: book ids, EPUB member paths, cover names,
  absolute-path shape checks, range headers, fixed MIME tables, the sidecar
  method allowlist, IPC channel names, the privileged-scheme table, and the
  sender-origin policy.
- `electron/main/protocolHandler.ts` — the pure `tuxbooks://` handler:
  scheme/host allowlist (`book`, `cover` only), strict URL parsing that
  fails closed (400/404/405/416), and fixed MIME types. Cover URLs carry
  the artwork-cache file name, never a path; main resolves the name inside
  the cache with lexical + realpath containment. The sidecar's wire
  media-type string is ignored for headers. Error bodies are fixed strings
  (`not found`, `internal error`, plus one per typed sidecar failure);
  upstream messages never leak. Typed sidecar codes keep their meaning at
  the protocol boundary: limit 413, sandbox 503, deadline 504, and 404
  only for genuine misses.
- `electron/main/ipcPolicy.ts` — the `tuxbooks:invoke` policy: sender must
  be the app page (`app://bundle` or the dev server), method allowlist,
  per-method param schemas, and an 8 MB params cap. `scan_library`,
  `reconnect_book`, and `set_book_cover` accept only paths main itself
  issued through a native dialog; `import_paths` also accepts drag-and-drop
  paths (shape-checked). Reveal takes a book id and resolves the path via
  the sidecar.
- `electron/main/ipcHandlers.ts` — the ipcMain handler wiring: invoke, the
  native dialogs, and reveal. Every channel gates its sender (the same
  app-page rule) before touching anything native, because the preload
  bridge is exposed to sandboxed publication frames. Registration and the
  native surfaces are injected, so the gate is tested without Electron.

The sidecar transport bounds both directions: requests over 8 MB are
rejected before write (`electron/main/sidecarTransport.ts`), and response
lines beyond the largest legitimate book payload are discarded instead of
buffered. Unknown JSON-RPC methods, malformed JSON, and malformed params
are rejected by the sidecar with typed JSON-RPC errors and never crash it
(pinned by `sidecar/src/rpc.rs` tests).

### Window hardening (issue #85, invariants X-1..X-5)

The Electron window and session are hardened by four more unit-tested
modules (`frontend/tests/security/`):

- `electron/main/windowSecurity.ts`: the X-1 isolation set
  (`contextIsolation`, `nodeIntegration: false`, `sandbox`,
  `webSecurity`), asserted at window creation so a drifted flag fails
  startup; the X-3 top-frame navigation allowlist (the app origin's entry
  point and assets, plus the dev server origin while one is configured;
  `file://` and everything else is prevented); and the X-4 permission
  policy: deny by default, the single grant being fullscreen from the
  app's own origin (the reader's presentation mode). Note that
  `new URL().origin` is `"null"` for custom schemes, so app-scheme
  request origins must be reconstructed from the host
  (`originOfRequestUrl`).
- `electron/shared/appCsp.ts`: the X-2 CSP for the app UI, served as a
  header on every `app://bundle` response and on the Vite dev server (the
  dev variant adds the three allowances HMR needs). The reader's blob:
  section frames inherit this policy, so it carries the frame grants the
  reader architecture requires (blob: toolkit scripts, ReadiumCSS inline
  and blob: styles, the `tuxbooks://` publication base URI). The shipped
  policy must not be stricter than the frame CSP in `contentPolicy.ts`,
  or the reader renders broken.
- `electron/shared/linkPolicy.ts`: the X-5 seam. The only inputs that
  reach `shell.openExternal` are canonical http(s) URLs re-serialized by
  `parseExternalHttpUrl`; scripts, data/file/custom schemes, credentials,
  control characters, and over-long strings are dropped.

### Metadata and annotation neutrality (issue #86, invariants M-1, M-2)

Publication-derived and user-stored strings (metadata fields, annotation
text/notes/locators, search hits, collection names, reader profile data) are
rendered only through React text nodes and escaped attributes; the renderer
has no `dangerouslySetInnerHTML`, no dynamic `href`, and no
`document.title`/clipboard/notifications fed from data. The single URL-carrying
sink is the stored cover path, which `lib/bridge.ts coverFileUrl` reduces to a
percent-encoded file name under the fixed `tuxbooks://cover/` scheme. Reader
profile values from localStorage are snapped back onto the supported scales on
read (`lib/readerSettings.ts`). Attack side: parse-time caps bound the strings
(`docs/RESOURCE_LIMITS.md`, including the attribute-derived calibre series
values), and the hostile-fixture tests in
`frontend/tests/security/metadataNeutrality.test.tsx` pin every sink above.
External navigation stays behind the X-5 `linkPolicy` gate.

### Document worker (issue #81, ADR 0001)

The sidecar spawns `tuxbooks-worker` one process per parse job, hands the
document over as a pre-opened read-only fd (fd 3, no path crosses the
boundary), enforces the wall-clock deadline by killing, and treats any
worker outcome as a typed per-job error (deadline -32001, limit -32002,
sandbox -32003, other worker failures -32004). On Linux the worker applies
Landlock (all filesystem access denied), a seccomp deny-list (including
socket creation, which owns network denial), and rlimits itself, then
self-verifies before parsing (ADR 0001). There is no in-process fallback:
a missing worker binary is a typed error, never silent in-process parsing.
The parse modules (`epub/`, `pdf/`) are worker-internal; services reach
them only through the worker client (`sidecar/src/worker/client.rs`).

## Gotchas

Each has bitten before (or is a known trap of the Electron stack):

- Electron security defaults are non-negotiable; no arbitrary
  `ipcRenderer` passthrough — the preload exposes only the enumerated
  `window.tuxbooks` API, consumed solely by `lib/bridge.ts`.
- Sidecar lifecycle: the sidecar survives a renderer reload and is shut
  down on quit — no orphaned processes. E2E arms `PR_SET_PDEATHSIG` on the
  sidecar for the same reason; see [TESTING.md](TESTING.md).

## Rust module contract

| Module                    | May depend on                                                                                         | Must never import             |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------- |
| `domain/`                 | std, serde, chrono, sqlx (row mapping only)                                                           | tauri, electron glue          |
| `limits/`                 | std, thiserror                                                                                        | runtime crates, sqlx          |
| `epub/` (worker-internal) | std, zip, quick-xml, limits                                                                           | tauri, sqlx, electron         |
| `pdf/` (worker-internal)  | std, lopdf, pdfium-render, limits                                                                     | tauri, sqlx, electron         |
| `worker/`                 | limits, epub, pdf, libc, serde, base64                                                                | sqlx, notify, tauri, electron |
| `db/`                     | sqlx, migrations                                                                                      | tauri, electron               |
| `repository/`             | sqlx, domain                                                                                          | tauri, epub, pdf              |
| `services/`               | domain, repository, worker, db, epub/pdf types + display projections (never their parse entry points) | tauri, electron               |
| method table              | services, domain                                                                                      | sqlx details                  |

Wiring (sidecar startup, pool init, method registration, IPC channel)
lives in the service binary's entry; `TEST_DATABASE_PATH` /
`TEST_LIBRARY_PATH` overrides are honored there (see
[TESTING.md](TESTING.md)).

Domain types derive `sqlx::FromRow` and `serde::Serialize` for pragmatism;
the rule that matters is: no domain file imports a runtime crate.

## Database layer

SQLite via SQLx with embedded migrations (`sidecar/migrations/`), run
deterministically by `db::connection::init_pool`. All queries are runtime
SQL (`sqlx::query`), not compile-time checked macros, so builds never
require a live database. See [DATABASE.md](DATABASE.md).

## EPUB layer

Import-time parsing stays in Rust (`epub/`, ZIP + OPF XML into a plain
`EpubBook`) under the shared resource limits (`docs/RESOURCE_LIMITS.md`).
Reader rendering belongs to **Readium TS Toolkit** in the
renderer, behind the single-module seam `lib/epub/readiumEngine.ts` —
publication parsing, navigator state, pagination, locators, selection, and
navigation are Readium's; React owns only the surrounding UI. EPUB
resources load through `tuxbooks://`. See [EPUB.md](EPUB.md).

## PDF layer

Import-time metadata stays in Rust (`pdf/` via `lopdf`; page-1 cover
rasterization via `pdfium-render` — retained unless MuPDF in the renderer
provably replaces it, see [PDF.md](PDF.md)), under the shared resource
limits ([RESOURCE_LIMITS.md](RESOURCE_LIMITS.md)). Reader rendering belongs to
**MuPDF.js/WASM** in the renderer behind `lib/pdf/pdfEngine.ts` (the only
MuPDF import site); `components/reader/pdf/` owns layout, virtualization,
the render queue, and persistence. Byte access flows through
`tuxbooks://`. See [PDF.md](PDF.md).

## Services

- `library_scanner`: pure filesystem read; recursive, typed per-file errors;
  discovers `.epub` and `.pdf` files (`parse_book` for one file,
  `list_book_files` for a parse-free listing used by reconciliation).
- `book_importer`: scan → upsert into `books` (keyed by path) → extract
  covers into the artwork cache next to the database (EPUB packages; PDF
  page 1 via PDFium, best effort). Idempotent on re-scan. Progress streams
  to the UI as `import-progress` notifications on the IPC channel.
- `artwork_cache`: content-addressed cover storage (`covers/<fnv1a>.<ext>`
  next to the database — stable, version-independent keys; identical bytes
  share one file, atomic writes). `sweep_unreferenced_covers` runs at
  startup and after book removal.
- `library_reconciler`: path truth — every book file in a watched location
  has exactly one available row; vanished files flip `available = 0` (never
  delete); renames/moves relink rows by id so progress and collections
  survive. Emits `LibraryChange` through a callback; wiring forwards it as
  the `library-changed` notification.
- `library_watcher`: `notify`-based watching of registered
  `library_locations` roots with a quiet-period debounce and rename
  pairing; one reconciler thread, never blocks the app.
- `reader`: controlled file-byte access — resolves a book id to its stored
  path via the repository and answers byte (range) requests for the
  `tuxbooks://` protocol handler; paths never cross the IPC boundary.
- `search`: library full-text search; sanitizes the raw user query into
  FTS5 MATCH syntax and queries `books_fts` (Ctrl/Cmd+K global search).
- `annotations`: persistent bookmarks/highlights; validates locators
  (EPUB CFI or 1-based PDF page + normalized geometry) and passes CRUD
  through `repository::annotations`.
- `metadata`: library curation — three-layer merge (`book_source_metadata`
  file truth, `book_metadata_overrides` user truth, effective `books`
  columns) plus normalized authors/subjects/series entities. Saving stores
  overrides without touching the file; the explicit `embed_book_metadata`
  action writes the effective text metadata back into the EPUB/PDF (see
  [EPUB.md](EPUB.md) / [PDF.md](PDF.md)), atomically and cover-free.
  `get_book_file_properties` reads the source file's native metadata fresh
  for the detail view's read-only "Original File Metadata" panel, and
  `set_metadata_field_source` persists a per-field library-vs-file choice
  that the merge honors.

Collection and progress plumbing stays in thin method + repository layers:
collections CRUD over `repository::collections`; `mark_book_finished` over
`repository::reading_progress` (`progress_percent = 100`, stored locators
untouched); `mark_book_opened` over `repository::books::mark_opened`
(`last_opened_at`, stamped when a reading session starts). `list_books`
LEFT JOINs `reading_progress`.

Bulk imports stream (issue #61): `import_directory` enumerates with
`list_book_files`, skips files whose size+mtime still match the stored row
(`ImportReport::skipped`), parses the rest with bounded concurrency
(3-permit `Semaphore` + `spawn_blocking`; covers extracted in the same
blocking task), and persists in arrival order over a channel — peak memory
is O(1) parsed book and `on_book` streams each persisted row to the
command layer, which batches them into `import-progress` events
(`{ books: [...] }`, count/time-triggered `ProgressBatcher`). The
watcher's per-file `import_file` path is unchanged.

## Frontend structure

```
frontend/src/
    types/domain.ts       TS mirrors of the Rust domain models (wire format)
    state/                app shell state (library/detail/reader) + providers
    lib/bridge.ts         the only window.tuxbooks consumer (typed wrappers)
    lib/shortcuts.ts      centralized keyboard shortcut registry
    lib/theme.ts          global light/dark theme logic (parse/resolve/apply)
    lib/readerSettings.ts persisted reader-appearance defaults (validated
                          localStorage store shared by Settings and the reader)
    lib/fixtures.ts       realistic sample books for tests/previews
    lib/epub/readiumEngine.ts  the only Readium import site (EPUB seam)
    lib/pdf/pdfEngine.ts  the only MuPDF.js import site (PDF seam)
    hooks/                useLibrary, useAnnotations, useBookMetadata,
                          useBookFileProperties, useBookActions,
                          useCollectionActions
    components/
        layout/           AppShell, Sidebar
        library/          LibraryView, header, empty states, import UX
        books/            BookCard, BookListItem, BookDetail (Overview /
                          Metadata rail), MetadataPanel (inline library
                          editing), FilePropertiesPanel, and metadata/
                          (shared form pieces: field grid, list editor,
                          cover field)
        search/           GlobalSearch (Ctrl/Cmd+K, backend FTS)
        reader/           ReaderShell — the format-agnostic reader model:
                          owns current book, progress, navigation entry
                          points, bookmark placement, in-book search state,
                          and the selection toolbar. The open format reader
                          registers its `ReaderAdapter` (`readerModel.ts`)
                          for jumps, search, and highlight creation. EPUB
                          reader (Readium) and pdf/ continuous PDF reader
                          (MuPDF; layout math, virtualization, render queue,
                          thumbnails, outline) implement the same seam.
                          ReaderNavigation holds the Search, Bookmarks, and
                          Highlights tabs.
        collections/      CollectionDialog
        settings/         SettingsShell
        ui/               shadcn/ui primitives (components.json, radix-nova)
```

UI primitives come from shadcn/ui (`pnpm dlx shadcn add ...`; icons from
`lucide-react`) — do not hand-roll equivalents. The `@/` alias maps to
`frontend/src/`. Business logic lives in Rust; readers own rendering;
React components render state and call the typed wrappers in
`lib/bridge.ts`; no component touches raw IPC, Readium, or MuPDF objects.
`LibraryDataProvider` owns the fetched library data (shared by the library
view, global search, and import flows); `ImportProvider` streams
`import-progress` events and listens to `library-changed` so watcher
reconciliations reach the UI live. `ThemeStateProvider` owns the global
light/dark theme: the System/Light/Dark preference persists in
`localStorage` (`tuxbooks.theme`), resolves against the OS color-scheme,
and applies as a `.dark` class on `<html>`; the inline bootstrap in
`index.html` mirrors that apply so startup never flashes the wrong theme.
The reading surface follows the global theme too (`autoReaderTheme` in
`readerState.ts`: dark → `dark` preset / PDF invert, light → publisher
default) until a theme is picked in the reader's appearance menu or in
Settings, which pins it. Reader appearance preferences persist on device in
`localStorage` (`tuxbooks.reader`, `lib/readerSettings.ts`): the reader
writes them on every change and Settings → Reading/PDF edits the same store,
so defaults apply to every book. Values are re-validated and snapped onto the
supported scales on read, so stale storage can never reach an engine.

## Testing layers

1. Rust unit + property tests (`cargo test`, per-module `#[cfg(test)]`)
2. Rust integration test (fixture → scan → DB → search slice)
3. Vitest + React Testing Library with a mocked IPC bridge (`frontend/tests/`)
4. Playwright E2E against the real Electron binary (`e2e/`)

See [TESTING.md](TESTING.md).
