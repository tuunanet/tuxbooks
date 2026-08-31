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
│  invoke("cmd", args) ────────────►  commands/  (IPC boundary)    │
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
files via `lopdf`; no rendering. PDFs import without covers. Rendering
happens in the frontend: the `get_book_bytes` command serves a book's file
bytes (`services/reader.rs`) and PDF.js rasterizes pages to a canvas
(`frontend/src/lib/pdf/pdfEngine.ts` is the only PDF.js import site). See
[pdf.md](pdf.md).

## Services

- `library_scanner`: pure filesystem read; recursive, typed per-file errors;
  discovers `.epub` and `.pdf` files.
- `book_importer`: scan → upsert into `books` (keyed by path) → extract
  covers next to the database (EPUBs only). Idempotent on re-scan.
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
        reader/           ReaderShell, PdfReader (PDF.js canvas), EpubReader placeholder,
                          navigation, appearance
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
`scan_library` for picked folders and drag-dropped paths.

## Testing layers

1. Rust unit + property tests (`cargo test`, per-module `#[cfg(test)]`)
2. Rust integration test (`src-tauri/tests/vertical_slice.rs`)
3. Vitest + React Testing Library with a mocked Tauri IPC (`frontend/tests/`)
4. WebdriverIO E2E against the built binary (`e2e/`)

See [testing.md](testing.md).
