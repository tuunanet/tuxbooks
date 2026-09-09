# Architecture

tuxbooks is a local-first desktop ebook library manager. There is no backend
server, no cloud sync, and no network dependency: Chromium (via Electron) is
the sole desktop web runtime; a native Rust service owns the database and
the filesystem; Readium and MuPDF.js render books.

**Migration state:** the Electron migration is complete. Historical phase
decisions live in [electron-migration.md](electron-migration.md); this doc
describes the current contract.

## Process and boundary

```
┌───────────────────────────────── Electron ──────────────────────────┐
│  Renderer (frontend/)              Main process (electron/main/)    │
│  React + TypeScript + Vite         window, dialogs/shell            │
│                                    ├─ tuxbooks:// protocol handler  │
│  window.tuxbooks (preload) ─────►  ├─ spawns + proxies the Rust     │
│  typed Promise result ◄─────────   │   sidecar (JSON-RPC, stdio)    │
│                                    └─ resource byte serving         │
│                                                                       │
│  Rust sidecar (native service)                                        │
│  ├─ services/ (application ops)   ├─ repository/ (SQL)                │
│  ├─ epub/ (parsing)               ├─ pdf/ (parsing)                   │
│  └─ db/ (SQLite + migrations)                                         │
└───────────────────────────────────────────────────────────────────────┘
```

- The renderer never touches Node.js (`nodeIntegration: false`),
  SQL, the filesystem, or ZIP archives. `electron/preload/` exposes a
  minimal, explicitly enumerated `window.tuxbooks`; the renderer's only
  consumer is `lib/bridge.ts`.
- The main process owns plumbing only: window lifecycle, dialogs/shell,
  the `tuxbooks://` protocol, sidecar spawn/health/restart/teardown. No
  business logic.
- The Rust sidecar never renders UI. Its method table only translates
  JSON-RPC payloads into service calls.
- Book bytes, covers, and EPUB resources flow through the scoped
  `tuxbooks://` custom protocol (range requests supported, granted to the
  app's origin only) — never an arbitrary local HTTP server; paths never
  cross into the renderer.

## Rust module contract

| Module        | May depend on                               | Must never import     |
| ------------- | ------------------------------------------- | --------------------- |
| `domain/`     | std, serde, chrono, sqlx (row mapping only) | tauri, electron glue  |
| `epub/`       | std, zip, quick-xml                         | tauri, sqlx, electron |
| `pdf/`        | std, lopdf                                  | tauri, sqlx, electron |
| `db/`         | sqlx, migrations                            | tauri, electron       |
| `repository/` | sqlx, domain                                | tauri, epub, pdf      |
| `services/`   | domain, repository, epub, pdf, db           | tauri, electron       |
| method table  | services, domain                            | sqlx details          |

Wiring (sidecar startup, pool init, method registration, IPC channel)
lives in the service binary's entry; `TEST_DATABASE_PATH` /
`TEST_LIBRARY_PATH` overrides are honored there (see
[testing.md](testing.md)).

Domain types derive `sqlx::FromRow` and `serde::Serialize` for pragmatism;
the rule that matters is: no domain file imports a runtime crate.

## Database layer

SQLite via SQLx with embedded migrations (`src-tauri/migrations/`), run
deterministically by `db::connection::init_pool`. All queries are runtime
SQL (`sqlx::query`), not compile-time checked macros, so builds never
require a live database. See [database.md](database.md).

## EPUB layer

Import-time parsing stays in Rust (`epub/`, ZIP + OPF XML into a plain
`EpubBook`). Reader rendering belongs to **Readium TS Toolkit** in the
renderer, behind the single-module seam `lib/epub/readiumEngine.ts` —
publication parsing, navigator state, pagination, locators, selection, and
navigation are Readium's; React owns only the surrounding UI. EPUB
resources load through `tuxbooks://`. See [epub.md](epub.md).

## PDF layer

Import-time metadata stays in Rust (`pdf/` via `lopdf`; page-1 cover
rasterization via `pdfium-render` — retained unless MuPDF in the renderer
provably replaces it, see [pdf.md](pdf.md)). Reader rendering belongs to
**MuPDF.js/WASM** in the renderer behind `lib/pdf/pdfEngine.ts` (the only
MuPDF import site); `components/reader/pdf/` owns layout, virtualization,
the render queue, and persistence. Byte access flows through
`tuxbooks://`. See [pdf.md](pdf.md).

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
  columns) plus normalized authors/subjects/series entities. Source files
  are never rewritten.

Collection and progress plumbing stays in thin method + repository layers:
collections CRUD over `repository::collections`; `mark_book_finished` over
`repository::reading_progress` (`progress_percent = 100`, stored locators
untouched). `list_books` LEFT JOINs `reading_progress`.

## Frontend structure

```
frontend/src/
    types/domain.ts       TS mirrors of the Rust domain models (wire format)
    state/                app shell state (library/detail/reader) + providers
    lib/bridge.ts         the only window.tuxbooks consumer (typed wrappers)
    lib/shortcuts.ts      centralized keyboard shortcut registry
    lib/fixtures.ts       realistic sample books for tests/previews
    lib/epub/readiumEngine.ts  the only Readium import site (EPUB seam)
    lib/pdf/pdfEngine.ts  the only MuPDF.js import site (PDF seam)
    hooks/                useLibrary, useAnnotations, useBookMetadata,
                          useBookActions, useCollectionActions
    components/
        layout/           AppShell, Sidebar
        library/          LibraryView, header, empty states, import UX
        books/            BookCard, BookListItem, BookDetail, metadata dialog
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
reconciliations reach the UI live.

## Testing layers

1. Rust unit + property tests (`cargo test`, per-module `#[cfg(test)]`)
2. Rust integration test (fixture → scan → DB → search slice)
3. Vitest + React Testing Library with a mocked IPC bridge (`frontend/tests/`)
4. Playwright E2E against the real Electron binary (`e2e/`)

See [testing.md](testing.md).
