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
| `db/`         | sqlx, migrations                            | tauri             |
| `repository/` | sqlx, domain                                | tauri, epub       |
| `services/`   | domain, repository, epub, db                | tauri             |
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

## Services

- `library_scanner`: pure filesystem read; recursive, typed per-file errors.
- `book_importer`: scan → upsert into `books` (keyed by path) → extract
  covers next to the database. Idempotent on re-scan.
- `search`: FTS5 MATCH queries against `books_fts`.

## Frontend structure

```
frontend/src/
    lib/tauri.ts          typed invoke wrappers (the only Tauri import site)
    hooks/useLibrary.ts   data loading for the library view
    components/
        layout/           AppShell, Sidebar
        library/          LibraryView, EmptyLibraryState
        books/            BookCard, icons
        reader/           placeholder
        ui/               shadcn/ui primitives (Button, Card)
```

Business logic lives in Rust. React components render state and call the
typed wrappers in `lib/tauri.ts`; no component invokes raw commands.

## Testing layers

1. Rust unit + property tests (`cargo test`, per-module `#[cfg(test)]`)
2. Rust integration test (`src-tauri/tests/vertical_slice.rs`)
3. Vitest + React Testing Library with a mocked Tauri IPC (`frontend/tests/`)
4. WebdriverIO E2E against the built binary (`e2e/`)

See [testing.md](testing.md).
