# Plan: Bookshelf-inspired UI/UX architecture

Source task: `prompt.txt` (establish UI/navigation architecture and visual
direction; no full reader implementation, metadata editing, or annotations
yet).

## Ground rules

- UI logic stays in TypeScript; business logic stays in Rust (AGENTS.md).
- `invoke` only in `frontend/src/lib/tauri.ts`; commands explicit and typed.
- No state-management library, no router dependency. The three application
  states (`library` / `detail` / `reader`) live in React context.
- No fake persistence (task §28): actions without backend backing get clearly
  structured placeholders, never pretend-success.
- Every stage ends with `just check`.

## Current state (verified)

- Commands: `list_books`, `get_library_stats`, `scan_library(path)`,
  `get_book_toc(bookId)`. No `get_book`, collections, or reading-progress
  commands yet (Rust repository support for collections/progress exists).
- Frontend: flat sidebar (Library/Collections/Reader placeholder), basic
  `LibraryView` + `BookCard`, shadcn `button`/`card` only, no keyboard
  infrastructure, no detail/reader/search/import UX.

## Stages

### Stage 0 — Foundations

- `src/types/domain.ts`: TS types mirroring Rust domain, incl. discriminated
  `ReadingProgress` (EPUB = `{ cfi, percentage }`, PDF = `{ page, percentage }`).
- `Book.format: "epub" | "pdf"` — small Rust change: expose format on the Book
  DTO (derived from the file extension in Rust) instead of parsing `path` in UI.
- `src/lib/fixtures.ts`: realistic mock books (EPUB + PDF, with/without
  progress) for visual evaluation and unit tests.
- shadcn primitives added as stages need them (`dropdown-menu`, `dialog`,
  `input`, `progress`, `slider`, `tabs`, `tooltip`, `scroll-area`,
  `separator`, `badge`).

### Stage 1 — Shell, navigation, shortcuts

- App state context: `view: "library" | "detail" | "reader"` +
  `selectedBookId` + active library section. Sidebar visible only outside the
  reader.
- Sidebar rework: LIBRARY group (All Books, EPUBs, PDFs, Recently Added,
  Recently Read, In Progress, Finished), COLLECTIONS group (+ New Collection,
  user collections), Settings at the bottom; visually distinct groups and a
  clear active state. Smart-collection filtering is client-side over
  `list_books` for now; backend filtering deferred.
- Centralized shortcut registry (`src/lib/shortcuts.ts` + provider):
  Ctrl/Cmd+K (global search focus), Escape (close overlay), Enter (open
  selected book); reader keys (Space, ←/→, Home/End, Ctrl+B, Ctrl+F) are
  registered by the reader scope only. No shortcuts hardcoded in leaf
  components.

### Stage 2 — Library screen

- Header: section title, book count, search field, `+ Import` menu (Import
  Files… / Import Folder…), Grid/List view toggle (default Grid, UI state).
- Sort control (Recently Added default).
- `BookCard`: cover, title, author, progress bar, hover/selected states,
  context menu — Open / Continue Reading enabled; Add to Collection, Mark as
  Finished, Edit Metadata, Show in File Manager, Remove from Library as
  structured disabled/placeholder actions.
- Interaction model: single click selects, double click / Enter opens detail;
  roving-focus keyboard grid; cards are real buttons (a11y §22).
- `BookList` variant; empty states: empty library, empty collection, no
  search results.

### Stage 3 — Import & search UX

- Import menu wired to existing `scan_library` (path source per decision D3).
- DropZone overlay using Tauri drag-drop events
  (`@tauri-apps/api/webview` `onDragDropEvent`) — Tauri intercepts HTML5 DnD,
  so DOM drag events must not be used.
- GlobalSearch: Ctrl/Cmd+K focus, client-side filter over title, author,
  publisher, ISBN, description, filename; results dropdown selects a book.
  No new backend indexing (FTS command deferred).

### Stage 4 — Book detail

- Detail view inside the library state: back to section, cover, title/author/
  format, progress, `[ Continue Reading ]`, description, details table,
  collection chips, `[ Edit Metadata ]` with an explicit "will be connected to
  the Rust backend" placeholder.
- Data from `list_books` client-side (no `get_book` command yet; D1).

### Stage 5 — Reader architecture

- `ReaderShell`: full-window, no sidebar; toolbar (← Library, title, 🔍, Aa,
  TOC, 🔖); bottom progress bar; visual language distinct from the library.
- `EpubReader` / `PdfReader` component boundaries with realistic placeholder
  documents. No rendering engines in this task.
- `ReaderNavigation` drawer: EPUB = Contents (from existing `get_book_toc`) +
  Bookmarks; PDF = Pages / Outline / Bookmarks.
- `ReaderAppearance` popover: font size, line spacing, theme
  (Light/Paper/Dark), layout (Paginated/Scrolling) — typed
  `ReaderPreferences`, presentational but stateful in React context.
- Reader keyboard navigation via the shortcut registry.

### Stage 6 — Collections & settings

- Collection UI: sidebar list, `CollectionDialog` (create), Add/Remove
  to/from collection submenu shells — no persistence, honest placeholders.
- `SettingsShell` + `SettingsNavigation`: General / Reading / PDF / Keyboard
  Shortcuts / Advanced sections, presentational rows only.

### Stage 7 — Tests

- Vitest suites for: sidebar rendering, active nav item, empty states, book
  card render/select, book detail, reader shells (EPUB/PDF), search focus
  shortcut, appearance popover, collection UI, import/drop-zone UI. Mocks via
  `vi.mock("@tauri-apps/api/core", ...)` in each test file; realistic fixture
  data; behavior-level assertions only.
- E2E: empty suite unchanged; seeded suite adds Library → Detail and
  Library → Reader (asserting the sidebar is hidden in the reader). Gate:
  `just test-e2e`.

### Stage 8 — Polish & definition of done

- Responsive: grid `auto-fill`/`minmax` columns for 1280×800 → large desktop,
  sidebar minimum width, reader max line width.
- A11y pass: focus-visible, accessible names, dialog/menu semantics, contrast.
- Full gate: `just ci`.

## Decision points

- **D1 — Rust surface**: frontend-first with the existing four commands;
  client-side derivation/fixtures where a command is missing. Deferred:
  `get_book(id)`, `get_collections`, reading-progress commands, `search_books`.
  Exception made for `Book.format` (Stage 0).
- **D2 — Covers**: real covers via the Tauri asset protocol
  (`convertFileSrc` + `assetProtocol` scope in `tauri.conf.json`; config
  change, no new dependency). Fixture/placeholder art until then.
- **D3 — Import path picker**: wiring `scan_library` to real files needs
  `@tauri-apps/plugin-dialog` (new dependency + capability). Alternatives: a
  dev-only path input, or deferring live import. Recommendation: add the
  plugin — a native picker is core desktop UX.

## Interaction model (binding)

Single click selects a book. Double click / Enter opens the book detail.
`Continue Reading` / `Open` in detail (and the context-menu Continue Reading)
enter the reader. Escape closes overlays. This satisfies the E2E smoke flow
Library → Detail → Reader.
