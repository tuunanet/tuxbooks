# Graph Report - tuxbooks  (2026-09-09)

## Corpus Check
- 284 files · ~239,010 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2764 nodes · 6206 edges · 169 communities (128 shown, 30 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 124 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `04d67e08`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- helpers.ts
- rpc.rs
- EpubError
- services/annotations.rs
- book_importer.rs
- ReaderShell.tsx
- services/metadata.rs
- fix-electron-main-window-behaviour.md
- PdfBitmapCache
- make-epub-fixtures.py
- repository/reading_progress.rs
- cn
- annotationModel.ts
- LibraryView.tsx
- BookMetadataDialog.tsx
- NewBook
- utils.ts
- react
- services/reader.rs
- library_sync.rs
- ReadiumEpubHandle
- lib/bridge.ts
- library_watcher.rs
- PdfReader.tsx
- e2e/package.json
- frontend/package.json
- radix-ui
- repository/metadata.rs
- desktop-shell.e2e.ts
- devDependencies
- repository/books.rs
- index.ts
- shortcuts.ts
- pdf/pdfEngine.ts
- compilerOptions
- usePdfDocument.ts
- 4K scrolling performance — implementation plan
- components.json
- EmptyLibraryState.tsx
- session.rs
- repository/collections.rs
- package.json
- ReaderAppearance.tsx
- epub/readiumEngine.ts
- parse_epub
- ImportProvider.tsx
- Reader rendering (Readium TS Toolkit)
- context-menu.tsx
- Stages
- 4K scrolling performance — investigation handover
- SettingsShell.tsx
- PdfReader.test.tsx
- environment.ts
- progressMigration.ts
- Rendering
- dependencies
- What You Must Do When Invoked
- Tables
- search.rs
- PdfPageCanvas.tsx
- commands/annotations.rs
- readerState.ts
- EPUB layer
- Implementation plan
- progress-migration.e2e.ts
- make-fixture.py
- artwork_cache.rs
- AGENTS.md
- Testing
- vitest
- compilerOptions
- Architecture
- Reader performance — bench findings and handover
- Coding standards
- EpubReader.tsx
- sweepProcesses
- scripts
- AppShell.tsx
- TuxBooks
- ROADMAP.md
- Development Principles
- Milestone 6 — Bookmarks, Highlights, and Notes
- Milestone 4 — Covers and Artwork Pipeline
- Scope
- Milestone 2 — PDF Navigation
- fetch-epub-extended.py
- bench-reader.e2e.ts
- Performance budgets and metrics
- Release and distribution
- Webview frame clock and dpr fiction — findings
- .consumeSearch
- Milestone 10 — Library and Reader UX Polish
- Milestone 7 — Metadata and Library Curation
- Milestone 3 — Filesystem Watcher and Library Reconciliation
- compilerOptions
- commands/reader.rs
- mupdfWorker.ts
- EpubReader.test.tsx
- fetch-ebook-fixtures.py
- Milestone 8 — Unified Reader Model
- Milestone 9 — Reader Reliability and Performance Hardening
- Milestone 11 — Release and Distribution
- Milestone 5 — Search
- mocks/bridge.ts
- Build and dev environment
- .prettierrc.json
- AppError
- PDF layer
- Coverage gate
- Confirming comment for WebKit bug 315997
- epub/metadata.rs
- vite.config.ts
- coverage-gate.mjs
- useEpubDocument.ts
- check-deb.sh
- extended_epub.rs
- .handlePositionChanged
- brand/README.md
- opencode.json
- fetch-pdfium.sh
- install-actionlint.sh
- run-parallel.sh
- img/README.md
- graphify reference: extra exports and benchmark
- commands/books.rs
- resolve_zip_path
- epub_corpus.rs
- library_locations.rs
- electron-app.ts
- vite-env.d.ts
- EPUB fixture corpus
- epub-reader.e2e.ts
- RangeStreamHandle
- BookMetadata
- ReadingProgress
- Conformance fixtures (Tier C)
- graphify reference: query, path, explain
- .resolveInitialLocator
- graphify reference: add a URL and watch a folder
- graphify reference: commit hook and native CLAUDE.md integration
- graphify reference: incremental update and cluster-only
- preload.ts
- Extended fixtures (Tier B)
- graphify.js
- graphify reference: GitHub clone and cross-repo merge
- graphify reference: transcribe video and audio
- main.rs
- tuxbooks.d.ts
- extraction-spec.md
- 0002_books_fts.sql
- 0005_library_sync.sql
- 0006_books_fts_extended.sql
- domain/library.rs
- tuxbooks
- MockIntersectionObserver
- manifest.json
- EBooks/AGENTS.md
- library_scanner.rs

## God Nodes (most connected - your core abstractions)
1. `AppError` - 149 edges
2. `cn()` - 101 edges
3. `react` - 67 edges
4. `ReadiumEpubHandle` - 57 edges
5. `vitest` - 36 edges
6. `init_pool()` - 32 edges
7. `import_directory()` - 31 edges
8. `PdfReader()` - 29 edges
9. `invoke()` - 27 edges
10. `mockInvoke()` - 27 edges

## Surprising Connections (you probably didn't know these)
- `openReadyEpub()` --calls--> `openInReader()`  [EXTRACTED]
  e2e/specs/epub-reader.e2e.ts → e2e/specs/helpers.ts
- `SidebarProps` --references--> `LibrarySection`  [EXTRACTED]
  frontend/src/components/layout/Sidebar.tsx → frontend/src/state/appState.ts
- `ItemButton()` --calls--> `cn()`  [EXTRACTED]
  frontend/src/components/layout/Sidebar.tsx → frontend/src/lib/utils.ts
- `PdfReader()` --indirect_call--> `pdfProgressPayload()`  [INFERRED]
  frontend/src/components/reader/pdf/PdfReader.tsx → frontend/src/components/reader/readerModel.ts
- `SettingsNavigation()` --calls--> `cn()`  [EXTRACTED]
  frontend/src/components/settings/SettingsShell.tsx → frontend/src/lib/utils.ts

## Import Cycles
- 2-file cycle: `sidecar/src/epub/mod.rs -> sidecar/src/epub/session.rs -> sidecar/src/epub/mod.rs`
- 2-file cycle: `sidecar/src/epub/metadata.rs -> sidecar/src/epub/mod.rs -> sidecar/src/epub/metadata.rs`

## Communities (169 total, 30 thin omitted)

### Community 0 - "helpers.ts"
Cohesion: 0.16
Nodes (32): bitmapCacheUsage(), canvasIsNonBlank(), clickUntilEffect(), closeReaderNavigation(), currentPageNumber(), ensureLibrary(), epubHostCount(), epubSectionTotal() (+24 more)

### Community 1 - "rpc.rs"
Cohesion: 0.05
Nodes (74): ImportReport, import_paths(), reconnect_book(), AppState, Book, Result, String, Vec (+66 more)

### Community 2 - "EpubError"
Cohesion: 0.27
Nodes (12): Attributes, attribute(), local_name(), EpubError, Error, String, parse_container_xml(), detect_fixed_layout() (+4 more)

### Community 3 - "services/annotations.rs"
Cohesion: 0.07
Nodes (65): AnnotationRect, Annotation, AnnotationKind, AnnotationPatch, AnnotationRect, NewAnnotation, DateTime, Option (+57 more)

### Community 4 - "book_importer.rs"
Cohesion: 0.09
Nodes (62): ProgressUpdate, init_pool(), init_pool_is_deterministic_and_idempotent(), Path, Result, SqlitePool, run_migrations(), schema_contains_all_core_tables() (+54 more)

### Community 5 - "ReaderShell.tsx"
Cohesion: 0.09
Nodes (36): byKind(), ReaderAppearance(), bookmarkInputFor(), jumpToSearchMatch(), ReaderJump, flattenOutline(), flattenToc(), OutlineRow (+28 more)

### Community 6 - "services/metadata.rs"
Cohesion: 0.14
Nodes (51): apply_source_metadata(), blank_title_is_rejected(), clean_list(), clean_optional(), clean_required(), clear_book_cover_override(), clearing_a_field_explicitly_overrides_it_to_empty(), cover_override_wins_and_survives_reimport() (+43 more)

### Community 7 - "fix-electron-main-window-behaviour.md"
Cohesion: 0.04
Nodes (46): 10. Add sensible minimum dimensions, 11. Window visibility/startup sequencing, 12. Application icon integration, 13. Add Electron `BrowserWindow` icon, 14. Use one canonical application icon source, 15. Update electron-builder product branding, 16. Desktop integration acceptance criteria, 17. Playwright/Electron regression tests (+38 more)

### Community 8 - "PdfBitmapCache"
Cohesion: 0.20
Nodes (4): bitmapBytes(), PdfBitmap, PdfBitmapCache, PdfPageCanvasProps

### Community 9 - "make-epub-fixtures.py"
Cohesion: 0.08
Nodes (30): build_all(), build_valid(), chapter_paragraph(), check(), emit_manifest(), main(), make(), _minimal_entries() (+22 more)

### Community 10 - "repository/reading_progress.rs"
Cohesion: 0.09
Nodes (41): book_collections, books, collections, reading_progress, annotations, authors, book_authors, book_metadata_overrides (+33 more)

### Community 11 - "cn"
Cohesion: 0.11
Nodes (29): Card(), CardAction(), CardContent(), CardDescription(), CardFooter(), CardHeader(), CardTitle(), DropdownMenu() (+21 more)

### Community 12 - "annotationModel.ts"
Cohesion: 0.14
Nodes (18): annotationRects(), DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_COLORS, HighlightColor, normalizeRect(), PdfHighlightOverlay(), COLOR_ORDER, ReaderAnnotationList() (+10 more)

### Community 13 - "LibraryView.tsx"
Cohesion: 0.15
Nodes (21): BookListItem(), EmptyCollectionState(), LibraryHeaderProps, columnCount(), LibraryView(), LibraryViewProps, NoSearchResultsState(), BOOK_SORT_OPTIONS (+13 more)

### Community 14 - "BookMetadataDialog.tsx"
Cohesion: 0.11
Nodes (24): BookMetadataDialog(), BookMetadataDialogProps, fromForm(), MetadataFormState, toForm(), CollectionDialogProps, NoSearchResultsStateProps, PdfToolbar() (+16 more)

### Community 15 - "NewBook"
Cohesion: 0.11
Nodes (19): LibraryStats, Book, book_serializes_with_camel_case_keys(), BookFormat, NewBook, DateTime, Error, Ok (+11 more)

### Community 16 - "utils.ts"
Cohesion: 0.22
Nodes (15): BookCard(), BookCardProps, InteractiveBookProps, progressPercentOf(), BookContextMenu(), BookContextMenuProps, BookCover(), BookCoverProps (+7 more)

### Community 17 - "react"
Cohesion: 0.18
Nodes (12): PdfScrollTrackingOptions, PdfDocumentView(), PdfDocumentViewProps, LayoutSlot, PdfPageLifecycle, PdfPageSlot(), PdfPageSlotProps, PdfPageTextLayer() (+4 more)

### Community 18 - "services/reader.rs"
Cohesion: 0.35
Nodes (13): epub_book(), load_book_file(), load_book_file_range(), load_book_resource(), load_epub_session(), loads_the_stored_file_bytes_for_a_book_id(), missing_file_surfaces_as_an_io_error(), Book (+5 more)

### Community 19 - "library_sync.rs"
Cohesion: 0.18
Nodes (27): LibraryChange, add_progress(), book_id_stored(), corrupt_file_is_skipped_and_imports_once_fixed(), created_file_is_imported_with_file_snapshot(), deleted_file_marks_book_unavailable_and_preserves_progress(), directory_rename_relinks_all_contained_books(), duplicate_and_rapid_events_reconcile_to_a_stable_state() (+19 more)

### Community 21 - "lib/bridge.ts"
Cohesion: 0.05
Nodes (66): PROGRESS_SAVE_DEBOUNCE_MS, ReaderProgressOptions, useReaderProgress(), AnnotationSnapshot, useAnnotations(), toMessage(), useBookActions(), LoadedView (+58 more)

### Community 22 - "library_watcher.rs"
Cohesion: 0.06
Nodes (65): Debug, Duration, Event, EventKind, FnOnce, Formatter, Handle, Mutex (+57 more)

### Community 23 - "PdfReader.tsx"
Cohesion: 0.11
Nodes (33): useFitWidthScale(), GeometryState, PdfGeometry, usePdfGeometry(), PdfAnchorInfo, READING_ANCHOR_RATIO, setScrollTop(), usePdfScrollTracking() (+25 more)

### Community 24 - "e2e/package.json"
Cohesion: 0.09
Nodes (21): devDependencies, electron, playwright, @playwright/test, tslib, @types/node, electron, @types/node (+13 more)

### Community 25 - "frontend/package.json"
Cohesion: 0.08
Nodes (28): @types/node, typescript, license, name, private, type, version, clsx (+20 more)

### Community 26 - "radix-ui"
Cohesion: 0.15
Nodes (14): Label(), Separator(), Tabs(), TabsContent(), TabsList(), tabsListVariants, TabsTrigger(), ToggleGroup() (+6 more)

### Community 27 - "repository/metadata.rs"
Cohesion: 0.27
Nodes (21): apply_effective(), clear_overrides(), EffectiveValues, ensure_series(), get_overrides(), get_source_metadata(), json_list(), list_book_authors() (+13 more)

### Community 28 - "desktop-shell.e2e.ts"
Cohesion: 0.22
Nodes (6): appEntryPoint, maximize(), maximizeIfSupported(), Rect, snapshot(), WindowSnapshot

### Community 29 - "devDependencies"
Cohesion: 0.09
Nodes (23): devDependencies, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, jsdom, shadcn (+15 more)

### Community 30 - "repository/books.rs"
Cohesion: 0.17
Nodes (38): count_books(), delete_book(), delete_cascades_to_reading_progress(), duplicate_path_violates_unique_constraint(), empty_title_is_rejected_by_check_constraint(), find_books_with_size(), find_id_by_path(), get_book() (+30 more)

### Community 31 - "index.ts"
Cohesion: 0.11
Nodes (24): APP_MIME_BY_EXTENSION, appIcon(), bookMime(), BOOT_START, bootElapsed(), COVER_MIME_BY_EXTENSION, coverMime(), coversDir() (+16 more)

### Community 32 - "shortcuts.ts"
Cohesion: 0.22
Nodes (11): GlobalSearchShortcut(), BARE_MODIFIER_KEYS, comboFromEvent(), ShortcutContext, ShortcutHandler, ShortcutRegistry, useShortcut(), isEditableTarget() (+3 more)

### Community 33 - "pdf/pdfEngine.ts"
Cohesion: 0.10
Nodes (22): PdfEnginePrewarm(), usePdfSearch(), cancelPdfPrewarm(), EngineTextLine, getPdfOutline(), getPdfPageText(), MuPdfDocument, openPdfDocument() (+14 more)

### Community 34 - "compilerOptions"
Cohesion: 0.09
Nodes (22): compilerOptions, baseUrl, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+14 more)

### Community 35 - "usePdfDocument.ts"
Cohesion: 0.26
Nodes (9): PdfDocumentSnapshot, PdfDocumentState, PdfDocumentStatus, usePdfDocument(), pdfOpenState, PdfOpenStateInput, pdfOpenTiming(), PdfOpenTimingParts (+1 more)

### Community 36 - "4K scrolling performance — implementation plan"
Cohesion: 0.09
Nodes (21): 4K scrolling performance — implementation plan, Cross-cutting rules for every step, Dependencies, Phase 0 — Baseline + diagnostics (do first, ships with Phase 1), Phase 1 — Cap the render buffer (PDF-1 / PERF-1) — the primary fix, Phase 2 — Pixel-aware bitmap cache (PDF-2 / PERF-3), Phase 3 — Byte-budgeted live canvases + compositing hygiene (PDF-3 / PERF-4 + PERF-6), Phase 4 — Blit without realloc (PDF-3, small) (+13 more)

### Community 37 - "components.json"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 38 - "EmptyLibraryState.tsx"
Cohesion: 0.33
Nodes (8): DropZoneOverlay(), EmptyLibraryState(), ImportStatus(), LibraryHeader(), importPaths(), pathForFile(), pickDirectory(), useImport()

### Community 39 - "session.rs"
Cohesion: 0.14
Nodes (33): books_without_toc_documents_read_without_a_toc(), build_manifest_json(), build_positions_json(), build_session(), builds_manifest_with_reading_order_and_toc(), builds_positions_across_spine(), clamp01(), container() (+25 more)

### Community 40 - "repository/collections.rs"
Cohesion: 0.15
Nodes (31): Collection, CollectionSummary, NewCollection, DateTime, String, Utc, Vec, add_book_to_collection() (+23 more)

### Community 41 - "package.json"
Cohesion: 0.06
Nodes (32): description, desktopName, devDependencies, electron, electron-builder, esbuild, prettier, @types/node (+24 more)

### Community 42 - "ReaderAppearance.tsx"
Cohesion: 0.13
Nodes (18): FONT_FAMILY_OPTIONS, LAYOUT_OPTIONS, THEME_OPTIONS, GlobalSearch(), splitSnippet(), Popover(), PopoverAnchor(), PopoverContent() (+10 more)

### Community 43 - "epub/readiumEngine.ts"
Cohesion: 0.07
Nodes (26): SerializedLocator, buildPositions(), EPUB_FONT_FAMILIES, EPUB_MIME_TYPE, EPUB_SCROLLED_SURFACE_MAX_PX, EpubAppearance, EpubFlow, EpubFontFamily (+18 more)

### Community 44 - "parse_epub"
Cohesion: 0.17
Nodes (28): empty_zip_reports_missing_mimetype(), mimetype_not_first_entry_reports_missing_mimetype(), missing_container_xml_reports_missing_container(), not_a_zip_reports_zip_error(), wrong_mimetype_reports_invalid_mimetype(), container_without_rootfile_reports_no_rootfile(), CoverImage, EpubBook (+20 more)

### Community 45 - "ImportProvider.tsx"
Cohesion: 0.39
Nodes (6): toMessage(), ImportContext, ImportFailure, ImportPhase, ImportState, ImportSummary

### Community 46 - "Reader rendering (Readium TS Toolkit)"
Cohesion: 0.20
Nodes (10): Annotations, Engine seam, In-book search, Position locator, Progress migration (foliate → Readium), Reader rendering (Readium TS Toolkit), Resource loading, Security (+2 more)

### Community 47 - "context-menu.tsx"
Cohesion: 0.18
Nodes (12): ContextMenu(), ContextMenuCheckboxItem(), ContextMenuContent(), ContextMenuItem(), ContextMenuLabel(), ContextMenuRadioItem(), ContextMenuSeparator(), ContextMenuShortcut() (+4 more)

### Community 48 - "Stages"
Cohesion: 0.12
Nodes (15): Current state (verified), Decision points, Ground rules, Interaction model (binding), Plan: Bookshelf-inspired UI/UX architecture, Stage 0 — Foundations (complete), Stage 1 — Shell, navigation, shortcuts, Stage 2 — Library screen (+7 more)

### Community 49 - "4K scrolling performance — investigation handover"
Cohesion: 0.12
Nodes (15): 4K scrolling performance — investigation handover, Environment-1 — Silent slow paths in the GPU stack, EPUB-1 — Paginated turns rasterize viewport-sized CSS columns, EPUB-2 — Scrolled flow: whole-section iframe layers, Executive summary, External evidence, How to reproduce / measure, PDF-1 — No canvas resolution cap (primary) (+7 more)

### Community 50 - "SettingsShell.tsx"
Cohesion: 0.29
Nodes (6): SECTION_ROWS, SECTIONS, SettingsNavigation(), SettingsRow, SettingsSectionId, SettingsShell()

### Community 51 - "PdfReader.test.tsx"
Cohesion: 0.07
Nodes (28): PdfPage, makeDomRect(), scrollTo(), stubScrollGeometry(), fireIntersection(), installMockIntersectionObserver(), intersectionObservers(), resetIntersectionObservers() (+20 more)

### Community 52 - "environment.ts"
Cohesion: 0.10
Nodes (26): armTeardownWatchdog(), libraryDir, prepareEnvironment(), pruneOldArtifacts(), pruneOldScratchDirs(), scratchDir, teardownEnvironment(), benchEpubFixture (+18 more)

### Community 53 - "progressMigration.ts"
Cohesion: 0.14
Nodes (22): CfiStep, convertCfiStructure(), convertExact(), convertFoliateRow(), convertSpineElement(), convertSpineProgression(), cssPath(), elementChildren() (+14 more)

### Community 54 - "Rendering"
Cohesion: 0.17
Nodes (12): Continuous reader architecture (`frontend/src/components/reader/pdf/`), Engine prewarm, In-book search, Open-timeline telemetry (state, not timing), Opening (range-backed, never whole-file), Outline, Reading position persistence, Rendering (+4 more)

### Community 55 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, class-variance-authority, clsx, cn, @fontsource-variable/geist, lucide-react, mupdf, radix-ui (+9 more)

### Community 56 - "What You Must Do When Invoked"
Cohesion: 0.08
Nodes (24): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Honesty Rules, Interpreter guard for subcommands, Part A - Structural extraction for code files (+16 more)

### Community 58 - "Tables"
Cohesion: 0.14
Nodes (14): annotations, book_collections, books, collections, Conventions, Database, Full-text search, library_locations (+6 more)

### Community 59 - "search.rs"
Cohesion: 0.16
Nodes (20): build_fts_query(), empty_query_is_invalid_input(), finds_books_by_description(), finds_books_by_isbn_and_by_file_name(), finds_books_by_publisher(), finds_books_by_title(), match_syntax_is_never_injected_through_user_input(), multi_term_query_requires_every_term() (+12 more)

### Community 60 - "PdfPageCanvas.tsx"
Cohesion: 0.15
Nodes (18): blit(), CancelledRender, PdfPageCanvas(), capByBytes(), effectiveRenderRatio(), MAX_ACTIVE_CANVAS_BYTES, MAX_RENDER_DIMENSION, MAX_RENDER_PIXELS (+10 more)

### Community 61 - "commands/annotations.rs"
Cohesion: 0.20
Nodes (18): AnnotationDto, AnnotationInput, AnnotationPatchInput, AnnotationRect, create_annotation(), delete_annotation(), list_annotations(), RectInput (+10 more)

### Community 62 - "readerState.ts"
Cohesion: 0.29
Nodes (6): DEFAULT_READER_PREFERENCES, ReaderContext, ReaderFontFamily, ReaderLayout, ReaderState, ReaderTheme

### Community 63 - "EPUB layer"
Cohesion: 0.29
Nodes (7): EPUB layer, Error handling, Fixtures, Known limitations (intentional, for now), Parsing stages, Public API, Rust import parser

### Community 64 - "Implementation plan"
Cohesion: 0.12
Nodes (15): 1. Manifest: `tests/fixtures/books/EBooks/manifest.json`, 2. Script: `scripts/fetch-ebook-fixtures.py`, 3. Justfile recipes, 4. Corpus selection (initial set), 5. Gitignore & fixture hygiene, 6. Test/doc updates, 7. Verification mechanism (summary), Candidate corpora (researched) (+7 more)

### Community 66 - "make-fixture.py"
Cohesion: 0.24
Nodes (10): build_pdf(), main(), Path, 64x64 solid sky-blue PNG built without external dependencies., Deterministic multi-page PDF: catalog, page tree, Info dictionary, one page…, Generate tests/fixtures/books/minimal.epub and minimal.pdf — tiny valid book…, tiny_png(), uniform_pages() (+2 more)

### Community 67 - "artwork_cache.rs"
Cohesion: 0.28
Nodes (15): cover_files(), make_covers_dir(), Option, Path, PathBuf, Result, SqlitePool, String (+7 more)

### Community 68 - "AGENTS.md"
Cohesion: 0.20
Nodes (8): Commands (in this order), Conventions, E2E for agents, External Knowledge & Source Research, graphify, Keep this file compact, What this project is, Working documents

### Community 69 - "Testing"
Cohesion: 0.17
Nodes (12): Benchmark suite (headed, opt-in), E2E (Playwright against Electron), EPUB fixture corpus (three tiers), Frontend (Vitest + RTL), Headless on Linux (Xvfb), Isolation, cleanup, termination, Parallelism, Rules for agents (+4 more)

### Community 70 - "vitest"
Cohesion: 0.12
Nodes (27): App(), AppShell(), AppStateProvider(), ImportProvider(), LibraryDataProvider(), renderDetail(), renderDialog(), withData() (+19 more)

### Community 71 - "compilerOptions"
Cohesion: 0.13
Nodes (14): compilerOptions, allowJs, checkJs, lib, module, moduleResolution, noEmit, noFallthroughCasesInSwitch (+6 more)

### Community 72 - "Architecture"
Cohesion: 0.20
Nodes (10): Architecture, Database layer, EPUB layer, Frontend structure, Gotchas, PDF layer, Process and boundary, Rust module contract (+2 more)

### Community 73 - "Reader performance — bench findings and handover"
Cohesion: 0.22
Nodes (8): Candidate next levers (ordered), Executive summary, Open questions, Reader performance — bench findings and handover, Rules of engagement (unchanged), The benchmark suite (what exists and how to use it), The measured record (Kubuntu Wayland, AMD + Mesa 26.0.8, 4K panel @ 60 Hz), What is NOT the bottleneck (measured, don't re-chase)

### Community 74 - "Coding standards"
Cohesion: 0.20
Nodes (10): Coding standards, Comments, Commits, Dependencies, Do not over-engineer, Frontend, Keep it small, Rust (+2 more)

### Community 75 - "EpubReader.tsx"
Cohesion: 0.08
Nodes (36): highlightCssColor(), isBookmarkAtLocator(), isBookmarkAtPage(), isHighlightColor(), ReaderAnnotationController, useEpubDocument(), EpubReader(), EpubReaderProps (+28 more)

### Community 76 - "sweepProcesses"
Cohesion: 0.23
Nodes (12): killStaleProcesses(), killAll(), processExe(), processStarttime(), safeReadDir(), sweepProcesses(), [electronDist, sidecar], ownStart (+4 more)

### Community 77 - "scripts"
Cohesion: 0.25
Nodes (8): scripts, build, dev, lint, preview, test, test:ci, typecheck

### Community 78 - "AppShell.tsx"
Cohesion: 0.13
Nodes (22): BookDetail(), formatDate(), CollectionDialog(), AppShellProps, Shell(), ItemButton(), ItemButtonProps, LIBRARY_ITEMS (+14 more)

### Community 79 - "TuxBooks"
Cohesion: 0.25
Nodes (8): Commands, Documentation, Getting started, Install, Layout, License, Stack, TuxBooks

### Community 80 - "ROADMAP.md"
Cohesion: 0.25
Nodes (7): Completed foundation, Current State, Milestone Completion Standard, Product Vision, Purpose, Recommended Execution Order, TuxBooks Milestones

### Community 81 - "Development Principles"
Cohesion: 0.25
Nodes (8): Avoid premature generalization, Development Principles, Local-first, No fake persistence, One subsystem at a time, Preserve working architecture, Real E2E matters, Tests are part of the feature

### Community 82 - "Milestone 6 — Bookmarks, Highlights, and Notes"
Cohesion: 0.25
Nodes (8): Bookmarks, Data model, Exit criteria, Goal, Highlights, Milestone 6 — Bookmarks, Highlights, and Notes, Notes, Reader UI

### Community 83 - "Milestone 4 — Covers and Artwork Pipeline"
Cohesion: 0.25
Nodes (8): Cache, EPUB, Exit criteria, Goal, Milestone 4 — Covers and Artwork Pipeline, PDF, Requirements, Testing

### Community 84 - "Scope"
Cohesion: 0.25
Nodes (8): EPUB engine, EPUB locator, EPUB reader, Exit criteria, Goal, Milestone 1 — Production EPUB Reader, Scope, Testing

### Community 85 - "Milestone 2 — PDF Navigation"
Cohesion: 0.25
Nodes (8): Exit criteria, Goal, Milestone 2 — PDF Navigation, Page thumbnails, PDF outline, Reader navigation, Scope, Testing

### Community 86 - "fetch-epub-extended.py"
Cohesion: 0.50
Nodes (7): already_cached(), extract(), fetch(), main(), Path, Fetch opt-in extended/conformance EPUB datasets (Tiers B and C). This is the…, sha256_file()

### Community 87 - "bench-reader.e2e.ts"
Cohesion: 0.16
Nodes (9): benchBookTitles, appendTrend(), BenchReport, DragResult, FrameStats, percentile(), report, summarize() (+1 more)

### Community 88 - "Performance budgets and metrics"
Cohesion: 0.25
Nodes (7): Budgets, How to measure, Legacy notes (WebKitGTK era, kept for context), Performance budgets and metrics, Reference conditions, Rules for changes, Touch-list

### Community 89 - "Release and distribution"
Cohesion: 0.29
Nodes (7): AppImage specifics, Artifacts, Cutting a release, Deliberate deferrals, Desktop identity (branding vs technical identifiers), Release and distribution, The packaging gate

### Community 90 - "Webview frame clock and dpr fiction — findings"
Cohesion: 0.29
Nodes (6): Appendix — probe sources, Verdict 1 — the ~31 fps idle ceiling is WebKitGTK engine-level, Verdict 2 — dpr 2 is fiction; the true compositor scale is 1.45, Webview frame clock and dpr fiction — findings, What this changes in the handover's lever list, Why no clamp was implemented (decision)

### Community 92 - "Milestone 10 — Library and Reader UX Polish"
Cohesion: 0.29
Nodes (7): Accessibility, Desktop behavior, Exit criteria, Goal, Library, Milestone 10 — Library and Reader UX Polish, Reader

### Community 93 - "Milestone 7 — Metadata and Library Curation"
Cohesion: 0.29
Nodes (7): Architecture, Exit criteria, Goal, Metadata, Milestone 7 — Metadata and Library Curation, Normalized entities, Optional future operation

### Community 94 - "Milestone 3 — Filesystem Watcher and Library Reconciliation"
Cohesion: 0.29
Nodes (7): Exit criteria, Goal, Milestone 3 — Filesystem Watcher and Library Reconciliation, Missing files, Reconnection, Scope, Testing

### Community 95 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, lib, module, moduleResolution, noEmit, noFallthroughCasesInSwitch, noUnusedLocals, skipLibCheck (+4 more)

### Community 96 - "commands/reader.rs"
Cohesion: 0.32
Nodes (11): get_book_bytes(), get_book_resource(), get_epub_session(), GetBookBytesResult, GetBookResourceResult, GetEpubSessionResult, AppState, Option (+3 more)

### Community 97 - "mupdfWorker.ts"
Cohesion: 0.18
Nodes (8): ensureEngine(), methods, MupdfDocument, MupdfModule, TextLine, WorkerRequest, WorkerResponse, mupdf

### Community 98 - "EpubReader.test.tsx"
Cohesion: 0.13
Nodes (20): ReaderProvider(), ReaderPreferences, fakeHandleOrThrow(), makeBookShim(), mockHappyPath(), renderReader(), renderReaderWithProbe(), renderSearchableReader() (+12 more)

### Community 99 - "fetch-ebook-fixtures.py"
Cohesion: 0.36
Nodes (10): corpus_files(), entry_status(), fetch(), hash_file(), load_manifest(), main(), Path, Fetch the free ebook fixture corpus (tests/fixtures/books/EBooks). Downloads… (+2 more)

### Community 100 - "Milestone 8 — Unified Reader Model"
Cohesion: 0.33
Nodes (6): Architecture, Document-specific position, Exit criteria, Goal, Milestone 8 — Unified Reader Model, Shared concepts

### Community 101 - "Milestone 9 — Reader Reliability and Performance Hardening"
Cohesion: 0.33
Nodes (6): Async lifecycle, Exit criteria, Goal, Memory, Milestone 9 — Reader Reliability and Performance Hardening, Test interactions

### Community 102 - "Milestone 11 — Release and Distribution"
Cohesion: 0.33
Nodes (6): CI, Exit criteria, Goal, Milestone 11 — Release and Distribution, Scope, Versioning policy (pre-1.0)

### Community 103 - "Milestone 5 — Search"
Cohesion: 0.33
Nodes (6): EPUB in-book search, Exit criteria, Goal, Library search, Milestone 5 — Search, PDF in-book search

### Community 104 - "mocks/bridge.ts"
Cohesion: 0.14
Nodes (20): MetadataFields, effective, nothingOverridden, renderDialog(), source, view, dragDrop(), dragEnter() (+12 more)

### Community 106 - "Build and dev environment"
Cohesion: 0.25
Nodes (7): Build and dev environment, Commands, Debug-build performance, E2E runtime, Electron bundles, Packaging (electron-builder), PDFium shared library (PDF covers)

### Community 107 - ".prettierrc.json"
Cohesion: 0.40
Nodes (4): printWidth, semi, singleQuote, trailingComma

### Community 108 - "AppError"
Cohesion: 0.17
Nodes (19): MigrateError, add_book_to_collection(), create_collection(), delete_collection(), list_collections(), remove_book_from_collection(), AppState, CollectionSummary (+11 more)

### Community 109 - "PDF layer"
Cohesion: 0.33
Nodes (5): Behavior, Error handling, Import mapping, PDF layer, Public API

### Community 110 - "Coverage gate"
Cohesion: 0.50
Nodes (3): Coverage gate, Outside the gate (and why), Required coverage by category

### Community 111 - "Confirming comment for WebKit bug 315997"
Cohesion: 0.50
Nodes (3): Comment text (copy everything inside the fence), Confirming comment for WebKit bug 315997, Follow-up comment — version A/B (paste only after the first comment)

### Community 112 - "epub/metadata.rs"
Cohesion: 0.20
Nodes (23): BytesStart, HashMap, calibre_series_fields_are_optional_and_tolerant(), detects_legacy_epub2_cover_meta(), EpubMetadata, handle_calibre_meta(), handle_itemref(), handle_legacy_cover_meta() (+15 more)

### Community 113 - "vite.config.ts"
Cohesion: 0.40
Nodes (4): mupdfWasmUrl, wasmFile, @tailwindcss/vite, @vitejs/plugin-react

### Community 114 - "coverage-gate.mjs"
Cohesion: 0.50
Nodes (3): byModule, cov, MODULES

### Community 117 - "useEpubDocument.ts"
Cohesion: 0.67
Nodes (3): EpubDocumentSnapshot, EpubDocumentState, EpubDocumentStatus

### Community 119 - "extended_epub.rs"
Cohesion: 0.33
Nodes (9): conformance_corpus_imports_every_book(), corpus_dir(), epub_files(), exercise_corpus(), extended_corpus_imports_every_book(), Option, Path, PathBuf (+1 more)

### Community 127 - "graphify reference: extra exports and benchmark"
Cohesion: 0.22
Nodes (8): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000)

### Community 128 - "commands/books.rs"
Cohesion: 0.33
Nodes (10): get_library_stats(), list_books(), remove_book(), AppState, Book, Result, SearchHit, String (+2 more)

### Community 129 - "resolve_zip_path"
Cohesion: 0.31
Nodes (9): normalize_path(), percent_decode(), resolve_zip_path(), String, resolve_nav_href(), Option, Value, split_fragment() (+1 more)

### Community 130 - "epub_corpus.rs"
Cohesion: 0.44
Nodes (8): core_corpus_stays_small(), corpus_root(), malformed_core_fixtures_are_rejected_for_both_generations(), malformed_fixtures(), PathBuf, Vec, valid_core_fixtures_parse_for_both_generations(), valid_fixtures()

### Community 131 - "library_locations.rs"
Cohesion: 0.36
Nodes (6): add_location(), list_locations(), Result, SqlitePool, String, Vec

### Community 133 - "electron-app.ts"
Cohesion: 0.12
Nodes (16): appArgs, deviceScaleFactor, launchElectronApp(), logLine(), patchEnvironmentRecord(), test, TestFixtures, versions (+8 more)

### Community 138 - "EPUB fixture corpus"
Cohesion: 0.40
Nodes (5): EPUB fixture corpus, Generation and validation, Layout, Licensing, Parser-facing contract

### Community 139 - "epub-reader.e2e.ts"
Cohesion: 0.32
Nodes (5): currentSection(), engineFraction(), engineMovedPast(), openReadyEpub(), epubLocator()

### Community 141 - "BookMetadata"
Cohesion: 0.48
Nodes (6): BookMetadata, MetadataFields, MetadataOverridden, Option, String, Vec

### Community 142 - "ReadingProgress"
Cohesion: 0.38
Nodes (6): ProgressUpdate, ReadingProgress, DateTime, Option, String, Utc

### Community 143 - "Conformance fixtures (Tier C)"
Cohesion: 0.50
Nodes (3): Conformance fixtures (Tier C), How it will work, W3C EPUB tests (candidate, not yet pinned)

### Community 144 - "graphify reference: query, path, explain"
Cohesion: 0.33
Nodes (5): For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal

### Community 146 - "graphify reference: add a URL and watch a folder"
Cohesion: 0.50
Nodes (3): For /graphify add, For --watch, graphify reference: add a URL and watch a folder

### Community 147 - "graphify reference: commit hook and native CLAUDE.md integration"
Cohesion: 0.50
Nodes (3): For git commit hook, For native CLAUDE.md integration, graphify reference: commit hook and native CLAUDE.md integration

### Community 148 - "graphify reference: incremental update and cluster-only"
Cohesion: 0.50
Nodes (3): For --cluster-only, For --update (incremental re-extraction), graphify reference: incremental update and cluster-only

### Community 365 - "library_scanner.rs"
Cohesion: 0.07
Nodes (63): Document, Object, PdfError, Error, String, build_pdf(), decode_pdf_string(), empty_title_field_falls_back_to_file_name() (+55 more)

## Knowledge Gaps
- **656 isolated node(s):** `$schema`, `plugin`, `printWidth`, `semi`, `singleQuote` (+651 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 968 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **30 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AppError` connect `AppError` to `commands/books.rs`, `rpc.rs`, `commands/reader.rs`, `EpubError`, `book_importer.rs`, `services/annotations.rs`, `library_locations.rs`, `artwork_cache.rs`, `repository/collections.rs`, `services/metadata.rs`, `repository/reading_progress.rs`, `search.rs`, `library_scanner.rs`, `services/reader.rs`, `library_watcher.rs`, `repository/metadata.rs`, `commands/annotations.rs`, `repository/books.rs`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Why does `react` connect `react` to `ReaderShell.tsx`, `cn`, `annotationModel.ts`, `LibraryView.tsx`, `BookMetadataDialog.tsx`, `utils.ts`, `lib/bridge.ts`, `PdfReader.tsx`, `frontend/package.json`, `radix-ui`, `shortcuts.ts`, `pdf/pdfEngine.ts`, `usePdfDocument.ts`, `EmptyLibraryState.tsx`, `ReaderAppearance.tsx`, `ImportProvider.tsx`, `context-menu.tsx`, `SettingsShell.tsx`, `PdfReader.test.tsx`, `PdfPageCanvas.tsx`, `readerState.ts`, `vitest`, `EpubReader.tsx`, `AppShell.tsx`, `EpubReader.test.tsx`, `useEpubDocument.ts`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `ReadiumEpubHandle` connect `ReadiumEpubHandle` to `EpubReader.test.tsx`, `epub/readiumEngine.ts`, `EpubReader.tsx`, `.resolveInitialLocator`, `useEpubDocument.ts`, `.handlePositionChanged`, `.consumeSearch`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `$schema`, `plugin`, `printWidth` to the rest of the system?**
  _656 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `rpc.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.05088919288645691 - nodes in this community are weakly interconnected._
- **Should `services/annotations.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.07289002557544758 - nodes in this community are weakly interconnected._
- **Should `book_importer.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.08638625056535504 - nodes in this community are weakly interconnected._