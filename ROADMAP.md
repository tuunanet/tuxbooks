# TuxBooks Milestones

## Purpose

TuxBooks is a local-first desktop ebook library and reader for Linux, built with Rust + Tauri and React + TypeScript.

The product goal is:

> **A fast, reliable, native-feeling personal library for local EPUB and PDF files, with high-quality reading experiences and no dependence on cloud services.**

The development strategy is incremental. Each milestone must leave the repository in a working state with automated tests and clear architectural boundaries.

The project should prioritize:

1. correctness
2. testability
3. local-first behavior
4. maintainable architecture
5. reader quality
6. performance
7. UX polish

Avoid implementing many features superficially. Complete one coherent subsystem at a time.

---

# Current State

## Completed foundation

TuxBooks currently has:

- Tauri 2 desktop application
- Rust backend
- React + TypeScript + Vite frontend
- SQLite persistence
- Rust domain/service/repository separation
- Tauri IPC boundaries
- local library indexing/import
- deterministic test fixtures
- Vitest frontend tests
- Rust unit/integration tests
- real Tauri/WebKitGTK E2E tests
- headless Linux E2E execution
- PDF.js integration
- secure Rust-controlled PDF byte access
- production-oriented continuous PDF reader
- PDF page virtualization
- PDF page geometry management
- PDF zoom
- PDF reading-position persistence
- PDF position restoration
- mixed-page-size PDF support
- page-level rendering error handling
- E2E rendering and scrolling verification
- vendored foliate-js EPUB engine behind a single-module seam
- production EPUB reader (chapter rendering, nested TOC, navigation)
- paginated and scrolled EPUB flow
- EPUB appearance controls (font size, font family, line spacing, themes)
- EPUB CFI + spine-href position persistence and validated restoration
- WebKit-native MathML rendering
- EPUB rendering/navigation/appearance E2E, including CFI persistence
- deterministic EPUB fixture with an EPUB 3 MathML chapter

The PDF subsystem should now be treated as the architectural reference for robust
document-reader engineering. The EPUB reader follows the same contract: a
single-module engine seam, persisted stable locators, and real desktop E2E.

---

# Milestone 1 — Production EPUB Reader

## Goal

Replace the current EPUB placeholder with a real EPUB reading experience.

EPUB is the most important remaining product gap.

The completed milestone should allow a user to:

```
open EPUB
    ↓
parse/load document
    ↓
view chapters
    ↓
navigate chapters
    ↓
change reading appearance
    ↓
leave the book
    ↓
reopen it at the previous location
```

## Scope

### EPUB engine

Evaluate and select an appropriate browser-side EPUB rendering solution.

Candidates may include:

- epub.js
- Readium-based technology
- another mature EPUB rendering implementation

Do not build a custom EPUB rendering engine unless there is a compelling technical reason.

Keep the EPUB engine behind a dedicated abstraction.

### EPUB reader

Implement:

- actual EPUB loading
- chapter rendering
- table of contents
- previous/next navigation
- continuous scrolling and/or pagination
- reading progress
- position persistence
- position restoration
- configurable font size
- font family where supported
- line spacing
- reading themes

### EPUB locator

Do not persist EPUB position as a percentage alone.

Use a stable document locator, such as:

```
EPUB resource/chapter
+
CFI or equivalent location
+
progression
```

The user should return to approximately the same logical text location after reopening the book.

### Testing

Provide:

- EPUB unit/integration tests
- deterministic EPUB fixtures
- frontend reader tests
- real Tauri E2E tests
- position persistence E2E
- appearance-control tests where practical

## Exit criteria

A real EPUB can be opened, read, navigated, and resumed after restarting the application.

---

# Milestone 2 — PDF Navigation

## Goal

Turn the existing production PDF renderer into a complete document-navigation experience.

## Scope

### Page thumbnails

Add a PDF sidebar with virtualized thumbnails.

Requirements:

- low-resolution rendering
- bounded thumbnail memory
- current-page indication
- click thumbnail → navigate to page
- efficient scrolling
- no full-document thumbnail rendering

### PDF outline

Read the PDF's existing outline/table of contents.

Display hierarchical entries.

Clicking an entry should navigate to its PDF destination.

### Reader navigation

Support:

- Pages
- Outline
- future Bookmarks placeholder if necessary

Do not implement annotations or text search yet.

## Testing

Test:

- thumbnail navigation
- current-page synchronization
- outline navigation
- large documents
- virtualized thumbnail rendering
- headless Tauri E2E

## Exit criteria

A user can efficiently navigate a large PDF without relying only on scrolling/page buttons.

---

# Milestone 3 — Filesystem Watcher and Library Reconciliation

## Goal

Evolve the library from a one-time importer into a continuously synchronized local library index.

## Scope

Detect:

- newly added books
- deleted files
- renamed files
- moved files
- modified files

Use a Rust filesystem watcher.

Architecture:

```
filesystem event
    ↓
affected path
    ↓
incremental reconciliation
    ↓
SQLite
    ↓
frontend update
```

Do not rebuild the entire library for every filesystem event.

### Missing files

If a file disappears:

```
Book
File unavailable

/path/to/book.epub

[Locate File]
[Remove from Library]
```

Do not automatically discard metadata, collections, or reading progress.

### Reconnection

Allow a missing book to be reconnected to a new path while preserving:

- book identity
- metadata
- collections
- reading progress
- future bookmarks/highlights

### Testing

Include filesystem integration tests for:

- creation
- deletion
- rename
- move
- modification
- duplicate events
- rapid event sequences

## Exit criteria

The library stays synchronized with configured filesystem locations without requiring manual rescans.

---

# Milestone 4 — Covers and Artwork Pipeline

## Goal

Make the library visually function as a polished bookshelf.

## EPUB

Extract the EPUB cover from its metadata/container.

## PDF

Generate a cover preview from the first page.

Use low-resolution rendering.

## Cache

Create a persistent artwork cache.

Conceptually:

```
cache/
  covers/
    <content-or-book-hash>.webp
```

Do not render covers repeatedly whenever the library opens.

## Requirements

- stable cache keys
- invalidation when source changes
- safe handling of missing covers
- placeholder artwork when extraction fails
- asynchronous generation
- no UI blocking during cover extraction

## Testing

Test:

- EPUB cover extraction
- PDF cover generation
- missing cover
- corrupt cover
- cache hit
- cache invalidation

## Exit criteria

The bookshelf displays attractive covers for both EPUB and PDF books with efficient caching.

---

# Milestone 5 — Search

## Goal

Implement library-wide and in-book search as two separate systems.

Do not conflate them.

## Library search

Search:

- title
- author
- publisher
- ISBN
- description
- filename
- future tags/subjects

Use SQLite FTS5 where appropriate.

Global shortcut:

```
Ctrl/Cmd + K
```

## EPUB in-book search

Search actual EPUB content.

Show:

```
query
result count
surrounding text/snippet
chapter
navigation to match
```

## PDF in-book search

Investigate using PDF.js text extraction/text layer and/or a backend indexing pipeline.

Do not implement a second unrelated search architecture if existing infrastructure can support it.

## Exit criteria

Users can quickly locate a book in the library and text inside a book.

---

# Milestone 6 — Bookmarks, Highlights, and Notes

## Goal

Add persistent reading annotations.

## Bookmarks

EPUB:

```
stable EPUB locator
```

PDF:

```
page number
optional page-local position
```

## Highlights

EPUB:

```
document locator
selected text
color
```

PDF:

```
page number
selection geometry
selected text where available
```

## Notes

Allow a note to be attached to a bookmark/highlight.

## Data model

Conceptually:

```
bookmarks
highlights
notes
```

Do not store UI coordinates as the sole persistent representation.

## Reader UI

Add:

```
Contents
Bookmarks
Highlights
```

to the reader navigation layer.

## Exit criteria

A user can create and revisit persistent reading annotations after restarting the application.

---

# Milestone 7 — Metadata and Library Curation

## Goal

Make the library manageable even when source files have inconsistent metadata.

## Metadata

Support:

- title
- subtitle
- author
- publisher
- language
- ISBN
- description
- subjects/categories
- series
- publication date
- cover

## Architecture

Keep the distinction between:

```
source-file metadata
```

and:

```
TuxBooks library metadata overrides
```

Do not silently rewrite EPUB/PDF files.

### Optional future operation

Provide an explicit advanced operation:

```
Save metadata into file
```

only as a later feature.

## Normalized entities

Prepare the data model for:

- multiple authors
- multiple subjects
- series
- collection membership

Avoid storing every relationship as an opaque string.

## Exit criteria

A user can correct and curate a messy local ebook collection without modifying source files unintentionally.

---

# Milestone 8 — Unified Reader Model

## Goal

Make EPUB and PDF share the appropriate application-level reader concepts without pretending that EPUB and PDF work identically.

## Shared concepts

The `ReaderShell` should own concepts such as:

- current book
- reading position
- progress
- navigation
- appearance state
- persistence
- reader lifecycle

## Document-specific position

PDF:

```
page
optional offset
```

EPUB:

```
chapter/resource
CFI/equivalent locator
progression
```

## Architecture

Conceptually:

```
ReaderShell
    │
    ├── PDF reader adapter
    │
    └── EPUB reader adapter
```

Avoid forcing the document-specific engines into an artificial common abstraction.

The shared layer should represent only genuinely shared application behavior.

## Exit criteria

ReaderShell can provide consistent navigation/persistence behavior while EPUB and PDF retain their own rendering models.

---

# Milestone 9 — Reader Reliability and Performance Hardening

## Goal

Bring the reading experience to release quality.

## Test interactions

Verify combinations of:

- open
- scroll quickly
- reverse scroll
- zoom
- resize window
- switch book
- close while rendering
- reopen
- change document type
- repeated open/close
- rapid navigation

## Memory

Measure:

- PDF canvas memory
- rendered-page count
- thumbnail memory
- EPUB document lifecycle
- cache growth

Avoid unbounded caches.

## Async lifecycle

Ensure:

- stale render tasks cannot update current UI
- old documents are destroyed
- unmounted components cannot update state
- cancellation is distinguishable from genuine failure
- rapid document switching is safe

## Exit criteria

Stress interactions produce no obvious race conditions, memory explosions, stale renders, or reader corruption.

---

# Milestone 10 — Library and Reader UX Polish

## Goal

Make TuxBooks feel like a finished desktop product.

## Library

Polish:

- grid
- list view
- sorting
- filtering
- selection
- context menus
- drag and drop
- empty states
- loading states
- error states

## Reader

Polish:

- toolbar
- page indicator
- transition behavior
- sidebars
- keyboard shortcuts
- focus handling
- appearance controls
- reader loading states

## Desktop behavior

Support:

- window resizing
- sensible minimum window size
- restoring window state
- keyboard-first workflows
- native file dialogs

## Accessibility

Audit:

- keyboard navigation
- accessible names
- focus states
- menus
- dialogs
- reader controls
- semantic structure
- color contrast

## Exit criteria

The application feels coherent and deliberate rather than like a collection of individually completed features.

---

# Milestone 11 — Release and Distribution

## Goal

Make TuxBooks installable by real users.

## Scope

Investigate and implement:

- Linux packaging
- AppImage where appropriate
- Debian/Ubuntu package where appropriate
- application icon
- desktop entry
- versioning
- release automation
- signed artifacts if appropriate
- update strategy if later required

Given the project's Ubuntu/Linux focus, prioritize the formats most useful for Ubuntu users.

## CI

Release pipeline should:

- build release binaries
- run unit/integration tests
- run headless E2E
- produce distributable artifacts

## Exit criteria

A person who has never cloned the repository can install and launch TuxBooks.

---

# Development Principles

## One subsystem at a time

Do not implement several large milestones simultaneously.

Each milestone should produce:

- code
- tests
- documentation
- working application state

## Preserve working architecture

Do not rewrite mature subsystems merely because a different implementation looks attractive.

Prefer incremental improvements.

## Tests are part of the feature

A feature is not complete merely because it works manually.

The milestone is incomplete until automated tests cover its important behavior.

## Real E2E matters

Keep both:

```
unit/integration tests
```

and:

```
real Tauri desktop E2E
```

The latter must continue running headlessly on Linux.

## Local-first

Do not introduce:

- cloud services
- external databases
- network dependencies

unless a feature genuinely requires them.

## No fake persistence

UI-only mocks are acceptable in isolated frontend tests.

Production flows must never pretend that data was saved when it was not.

## Avoid premature generalization

Do not build generic systems for hypothetical future formats.

Implement good EPUB and PDF support first.

---

# Recommended Execution Order

The preferred implementation sequence is:

```
1. Production EPUB Reader
       ↓
2. PDF Thumbnails + Outline
       ↓
3. Filesystem Watcher + Reconciliation
       ↓
4. Covers + Artwork Cache
       ↓
5. Search
       ↓
6. Bookmarks + Highlights + Notes
       ↓
7. Metadata + Library Curation
       ↓
8. Unified Reader Model
       ↓
9. Reliability + Performance Hardening
       ↓
10. UX Polish
       ↓
11. Release + Distribution
```

The ordering is deliberate.

In particular:

- EPUB should be completed before adding many annotation features.
- PDF thumbnails should reuse the existing virtualized page architecture.
- filesystem reconciliation should exist before sophisticated library curation.
- covers should exist before finalizing bookshelf UX.
- search should exist before advanced notes/annotation UX.
- unified reader abstractions should emerge from the real EPUB/PDF implementations, not be over-designed beforehand.
- release packaging should wait until the core reader/library workflows are stable.

---

# Milestone Completion Standard

Every milestone should end with:

```
just check
just test-e2e
just build
```

and, where applicable:

- updated fixtures
- updated E2E tests
- updated documentation
- updated `AGENTS.md`
- no regressions in completed milestones

A milestone is complete only when both the implementation and its automated verification are complete.

---

# Product Vision

The long-term TuxBooks architecture should converge toward:

```
                     TUXBOOKS
                        │
                ┌───────┴───────┐
                │   Library     │
                └───────┬───────┘
                        │
            ┌───────────┴───────────┐
            ↓                       ↓
         EPUB                      PDF
            │                       │
    reflowable reader       continuous reader
            │                       │
            └───────────┬───────────┘
                        ↓
                   ReaderShell
                        │
          ┌─────────────┼─────────────┐
          ↓             ↓             ↓
       progress      bookmarks      search
          │             │             │
          └─────────────┼─────────────┘
                        ↓
                     SQLite
                        │
                        ↓
                   local files
```

The product should ultimately feel simple to the user:

```
Open TuxBooks
    ↓
See your books
    ↓
Find one
    ↓
Open it
    ↓
Read
    ↓
Close it
    ↓
Come back later
    ↓
Continue exactly where you stopped
```

The engineering underneath that experience should remain robust, local, testable, and friendly to autonomous coding agents.
