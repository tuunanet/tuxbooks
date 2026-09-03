# Architecture

tuxbooks is a local-first desktop ebook library manager built with Tauri 2.
There is no backend server, no cloud sync, and no network dependency: the
Rust process owns the database and the filesystem; the webview renders.

## Process and boundary

```
┌──────────────────────────── Tauri app ────────────────────────────┐
│  WebView (frontend/)                Rust process (src-tauri/)     │
│  React + TypeScript + Vite          Tauri runtime (tokio)         │
│                                     │                             │
│  invoke("cmd", args) ────────────►  commands/  (IPC boundary)     │
│  typed Promise result  ◄──────────  services/ (application ops)   │
│                                     ├─ repository/ (SQL)          │
│                                     ├─ epub/ (parsing)            │
│                                     ├─ pdf/ (parsing)             │
│                                     └─ db/ (SQLite + migrations)  │
└───────────────────────────────────────────────────────────────────┘
```

- The frontend never touches SQL, the filesystem, or ZIP archives.
- Rust never renders UI. Tauri commands only translate IPC payloads into
  service calls; they contain no business logic.

## Rust module contract

| Module        | May depend on                               | Must never import |
| ------------- | ------------------------------------------- | ----------------- |
| `domain/`     | std, serde, chrono, sqlx (row mapping only) | tauri             |
| `epub/`       | std, zip, quick-xml                         | tauri, sqlx       |
| `pdf/`        | std, lopdf                                  | tauri, sqlx       |
| `db/`         | sqlx, migrations                            | tauri             |
| `repository/` | sqlx, domain                                | tauri, epub, pdf  |
| `services/`   | domain, repository, epub, pdf, db           | tauri             |
| `commands/`   | services, domain, `State<AppState>`         | sqlx details      |

`lib.rs` owns wiring: it resolves the database path (see
[testing.md](testing.md) for the `TEST_DATABASE_PATH` / `TEST_LIBRARY_PATH`
overrides), initializes the pool, registers managed state, and registers
commands. `main.rs` only calls `tuxbooks_lib::run()`.

Domain types derive `sqlx::FromRow` and `serde::Serialize` for pragmatism;
the rule that matters is: no domain file imports `tauri`.

## Database layer

SQLite via SQLx with embedded migrations (`src-tauri/migrations/`), run
deterministically by `db::connection::init_pool`. All queries are runtime
SQL (`sqlx::query`), not compile-time checked macros, so builds never
require a live database. See [database.md](database.md).

## EPUB layer

`epub/` parses EPUB containers (ZIP + OPF XML) into a plain `EpubBook`
value. It is Tauri- and database-independent and unit-tested against
`tests/fixtures/books/minimal.epub`. See [epub.md](epub.md).

## PDF layer

`pdf/` extracts bibliographic metadata (title/author/subject) from PDF
files via `lopdf` and rasterizes page 1 to a PNG cover at import time via
`pdfium-render` (`pdf/render.rs`), probing for the PDFium shared library
fetched by `scripts/fetch-pdfium.sh` (see [build.md](build.md)); when the
library is absent, PDFs import without covers. Reader rendering happens in
the frontend as a continuous, virtualized reader: the
`get_book_bytes` command serves a book's file bytes (`services/reader.rs`)
and PDF.js rasterizes pages to canvases (`frontend/src/lib/pdf/pdfEngine.ts`
is the only PDF.js import site; the `components/reader/pdf/` modules own
layout, virtualization, the render queue, and persistence — see
[pdf.md](pdf.md)).

## Services

- `library_scanner`: pure filesystem read; recursive, typed per-file errors;
  discovers `.epub` and `.pdf` files (`parse_book` for one file,
  `list_book_files` for a parse-free listing used by reconciliation).
- `book_importer`: scan → upsert into `books` (keyed by path) → extract
  covers next to the database (EPUB packages; PDF page 1 via PDFium, best
  effort). Idempotent on re-scan. Takes a per-book progress callback; the
  `scan_library` command forwards it as `import-progress` events so the UI
  shows books and covers while the scan runs. `import_file` is the
  single-file primitive the watcher reuses.
- `library_reconciler`: turns filesystem observations into minimal database
  transitions (milestone 3). Path truth: every book file in a watched
  location has exactly one available row; vanished files flip
  `available = 0` (never delete); renames/moves relink rows by id so
  progress and collections survive. Also owns startup/periodic
  reconciliation of watched locations and the explicit `reconnect_book`
  flow. Emits `LibraryChange` through a callback — the only Tauri-free
  seam; `lib.rs` wires it to the `library-changed` IPC event.
- `library_watcher`: `notify`-based watching of the registered
  `library_locations` roots (recursive), with a quiet-period debounce,
  rename pairing that survives window boundaries, and a reconciliation
  sweep after lost-destination moves or backend rescan requests. One
  reconciler thread; never blocks the app. Runs only for watched roots.
- `reader`: controlled file-byte access for the reading engines — resolves a
  book id to its stored path via the repository and reads it; paths never
  cross the IPC boundary.
- `search`: FTS5 MATCH queries against `books_fts`.

## Frontend structure

```
frontend/src/
    types/domain.ts       TS mirrors of the Rust domain models (wire format)
    state/                app shell state (library/detail/reader) + providers
    lib/tauri.ts          typed invoke wrappers + plugin APIs (the only Tauri import site)
    lib/shortcuts.ts      centralized keyboard shortcut registry
    lib/fixtures.ts       realistic sample books for tests/previews
    lib/pdf/pdfEngine.ts  the only PDF.js import site (worker setup + open/close)
    hooks/useLibrary.ts   shared library data loading (`useLibraryData` + `useLibrary`)
    components/
        layout/           AppShell, Sidebar
        library/          LibraryView, header, empty states, import UX, section helpers
        books/            BookCard, BookListItem, BookDetail, book context menu
        search/           GlobalSearch (Ctrl/Cmd+K) + client-side searchBooks
        reader/           ReaderShell, EPUB reader, pdf/ continuous PDF
                          reader (layout math, virtualization, render queue,
                          scroll tracking, thumbnails sidebar, outline,
                          persistence — see pdf.md)
        collections/      CollectionDialog (creation shell, not backend-wired yet)
        settings/         SettingsShell with presentational sections
        ui/               shadcn/ui primitives (components.json, radix-nova)
```

UI primitives come from shadcn/ui (`pnpm dlx shadcn add ...`; icons from
`lucide-react`) — do not hand-roll equivalents. The `@/` alias maps to
`frontend/src/`. Business logic lives in Rust. React components render state
and call the typed wrappers in `lib/tauri.ts`; no component invokes raw
commands. `LibraryDataProvider` owns the fetched library data so the library
view, global search, and import flows share one copy; `ImportProvider` runs
`scan_library` for picked folders and drag-dropped paths, while the provider
patches its book list from `import-progress` events so imports stream in.
The same provider listens to `library-changed` events, so watcher
reconciliations (new/updated/relinked books, missing files, removals) reach
the UI live without polling. Missing-file recovery UI (Locate File /
Remove) lives on the book card, list row, detail view, and context menu,
driven by `hooks/useBookActions.ts`.

## Testing layers

1. Rust unit + property tests (`cargo test`, per-module `#[cfg(test)]`)
2. Rust integration test (`src-tauri/tests/vertical_slice.rs`)
3. Vitest + React Testing Library with a mocked Tauri IPC (`frontend/tests/`)
4. WebdriverIO E2E against the built binary (`e2e/`)

See [testing.md](testing.md).
