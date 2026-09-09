# Graph Report - tuxbooks  (2026-09-09)

## Corpus Check
- 274 files · ~190,108 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2646 nodes · 6051 edges · 157 communities (124 shown, 22 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 124 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `cb57f5dd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- utils.ts
- BookMetadataDialog.tsx
- library_sync.rs
- EpubReader.test.tsx
- react
- cn
- usePdfDocument.ts
- test
- PdfDocument
- EventEmitter
- shortcuts.ts
- PdfReader.tsx
- PdfBitmapCache
- commands/metadata.rs
- dispatch
- mocks/bridge.ts
- PdfDocumentView.tsx
- ReaderShell.tsx
- EpubError
- mupdfWorker.ts
- TuxbooksApi
- import_paths
- library_locations.rs
- vite.config.ts
- lib/bridge.ts
- services/annotations.rs
- services/metadata.rs
- lib.rs
- AppShell.tsx
- PdfReader.test.tsx
- book_importer.rs
- ReadiumEpubHandle
- repository/books.rs
- session.rs
- repository/metadata.rs
- parse_epub
- make-epub-fixtures.py
- rpc.rs
- epub/readiumEngine.ts
- environment.ts
- frontend/package.json
- helpers.ts
- library_watcher.rs
- index.ts
- package.json
- e2e/package.json
- repository/reading_progress.rs
- ReaderNavigation.tsx
- library_scanner.rs
- epub/metadata.rs
- What You Must Do When Invoked
- repository/collections.rs
- search.rs
- devDependencies
- compilerOptions
- commands/annotations.rs
- 4K scrolling performance — implementation plan
- components.json
- dependencies
- progressMigration.ts
- compilerOptions
- ReaderAppearance.tsx
- resolve_zip_path
- NewBook
- Stages
- 4K scrolling performance — investigation handover
- artwork_cache.rs
- Rendering
- PdfPageCanvas.tsx
- services/reader.rs
- Tables
- bench-reader.e2e.ts
- compilerOptions
- AGENTS.md
- Testing
- global-setup.ts
- make-fixture.py
- Coding standards
- AppError
- pdf/pdfEngine.ts
- commands/reader.rs
- Reader rendering (Readium TS Toolkit)
- commands/books.rs
- extended_epub.rs
- Architecture
- Reader performance — bench findings and handover
- sweepProcesses
- graphify reference: extra exports and benchmark
- epub_corpus.rs
- Build and dev environment
- Electron migration plan
- Performance budgets and metrics
- scripts
- .handlePositionChanged
- TuxBooks
- ROADMAP.md
- Development Principles
- Milestone 6 — Bookmarks, Highlights, and Notes
- Milestone 4 — Covers and Artwork Pipeline
- Scope
- Milestone 2 — PDF Navigation
- fetch-epub-extended.py
- EPUB layer
- Release and distribution
- Webview frame clock and dpr fiction — findings
- Milestone 10 — Library and Reader UX Polish
- Milestone 7 — Metadata and Library Curation
- Milestone 3 — Filesystem Watcher and Library Reconciliation
- BookMetadata
- epub-reader.e2e.ts
- electron-app.ts
- graphify reference: query, path, explain
- Milestone 8 — Unified Reader Model
- Milestone 9 — Reader Reliability and Performance Hardening
- Milestone 11 — Release and Distribution
- Milestone 5 — Search
- ReadingProgress
- .prettierrc.json
- MockIntersectionObserver
- Coverage gate
- Confirming comment for WebKit bug 315997
- graphify reference: add a URL and watch a folder
- graphify reference: commit hook and native CLAUDE.md integration
- graphify reference: incremental update and cluster-only
- coverage-gate.mjs
- preload.ts
- opencode.json
- graphify.js
- graphify reference: GitHub clone and cross-repo merge
- graphify reference: transcribe video and audio
- check-deb.sh
- main.rs
- useEpubDocument.ts
- brand/README.md
- extraction-spec.md
- fetch-pdfium.sh
- install-actionlint.sh
- run-parallel.sh
- img/README.md
- domain/library.rs
- vite-env.d.ts
- tuxbooks
- tuxbooks.d.ts
- 0002_books_fts.sql
- 0005_library_sync.sql
- 0006_books_fts_extended.sql

## God Nodes (most connected - your core abstractions)
1. `AppError` - 149 edges
2. `cn()` - 101 edges
3. `react` - 66 edges
4. `ReadiumEpubHandle` - 57 edges
5. `vitest` - 35 edges
6. `init_pool()` - 32 edges
7. `import_directory()` - 31 edges
8. `PdfReader()` - 27 edges
9. `invoke()` - 27 edges
10. `mockInvoke()` - 27 edges

## Surprising Connections (you probably didn't know these)
- `openReadyEpub()` --calls--> `openInReader()`  [EXTRACTED]
  e2e/specs/epub-reader.e2e.ts → e2e/specs/helpers.ts
- `ItemButton()` --calls--> `cn()`  [EXTRACTED]
  frontend/src/components/layout/Sidebar.tsx → frontend/src/lib/utils.ts
- `PdfPageTextLayerProps` --references--> `PdfDocument`  [EXTRACTED]
  frontend/src/components/reader/pdf/PdfPageTextLayer.tsx → frontend/src/lib/pdf/pdfEngine.ts
- `SearchProps` --references--> `ReaderAdapter`  [EXTRACTED]
  frontend/tests/EpubReader.test.tsx → frontend/src/components/reader/readerModel.ts
- `SettingsNavigation()` --calls--> `cn()`  [EXTRACTED]
  frontend/src/components/settings/SettingsShell.tsx → frontend/src/lib/utils.ts

## Import Cycles
- 2-file cycle: `src-tauri/src/epub/metadata.rs -> src-tauri/src/epub/mod.rs -> src-tauri/src/epub/metadata.rs`
- 2-file cycle: `src-tauri/src/epub/mod.rs -> src-tauri/src/epub/session.rs -> src-tauri/src/epub/mod.rs`

## Communities (157 total, 22 thin omitted)

### Community 0 - "utils.ts"
Cohesion: 0.10
Nodes (29): BookCard(), BookCardProps, InteractiveBookProps, progressPercentOf(), BookContextMenu(), BookContextMenuProps, BookCover(), BookCoverProps (+21 more)

### Community 1 - "BookMetadataDialog.tsx"
Cohesion: 0.10
Nodes (27): BookMetadataDialog(), BookMetadataDialogProps, fromForm(), MetadataFormState, toForm(), CollectionDialogProps, CreateResult, NoSearchResultsState() (+19 more)

### Community 2 - "library_sync.rs"
Cohesion: 0.18
Nodes (27): LibraryChange, add_progress(), book_id_stored(), corrupt_file_is_skipped_and_imports_once_fixed(), created_file_is_imported_with_file_snapshot(), deleted_file_marks_book_unavailable_and_preserves_progress(), directory_rename_relinks_all_contained_books(), duplicate_and_rapid_events_reconcile_to_a_stable_state() (+19 more)

### Community 3 - "EpubReader.test.tsx"
Cohesion: 0.13
Nodes (21): EpubRelocateDetail, EpubSearchCallbacks, ReaderProvider(), fakeHandleOrThrow(), makeBookShim(), mockHappyPath(), renderReader(), renderReaderWithProbe() (+13 more)

### Community 4 - "react"
Cohesion: 0.14
Nodes (17): DropZoneOverlay(), ImportStatus(), SECTION_ROWS, SECTIONS, SettingsNavigation(), SettingsRow, SettingsSectionId, SettingsShell() (+9 more)

### Community 5 - "cn"
Cohesion: 0.08
Nodes (37): BookListItem(), Card(), CardAction(), CardContent(), CardDescription(), CardFooter(), CardHeader(), CardTitle() (+29 more)

### Community 6 - "usePdfDocument.ts"
Cohesion: 0.18
Nodes (8): PdfDocumentSnapshot, PdfDocumentState, PdfDocumentStatus, usePdfDocument(), closePdfDocument(), MuPdfDocument, openPdfDocument(), WorkerClient

### Community 7 - "test"
Cohesion: 0.16
Nodes (8): test, seededBookTitles, ensureLibrary(), openBookDetail(), returnToLibrary(), waitForLibraryView(), seededEpub, OLD_FOLIATE_CFI

### Community 8 - "PdfDocument"
Cohesion: 0.18
Nodes (11): GeometryState, PdfGeometry, PdfVirtualization, usePdfVirtualization(), PageSize, thumbnailGeometry(), MAX_THUMBNAIL_CANVASES, PdfSidebar() (+3 more)

### Community 9 - "EventEmitter"
Cohesion: 0.18
Nodes (16): delete_collection_takes_the_bridge_wire_param(), EventEmitter, handle_line(), ping_answers_pong(), AppState, Arc, F, Fn (+8 more)

### Community 10 - "shortcuts.ts"
Cohesion: 0.22
Nodes (11): GlobalSearchShortcut(), BARE_MODIFIER_KEYS, comboFromEvent(), ShortcutContext, ShortcutHandler, ShortcutRegistry, useShortcut(), isEditableTarget() (+3 more)

### Community 11 - "PdfReader.tsx"
Cohesion: 0.14
Nodes (26): normalizeRect(), useFitWidthScale(), usePdfGeometry(), PdfAnchorInfo, READING_ANCHOR_RATIO, setScrollTop(), usePdfScrollTracking(), clampOffset() (+18 more)

### Community 12 - "PdfBitmapCache"
Cohesion: 0.20
Nodes (4): bitmapBytes(), PdfBitmap, PdfBitmapCache, PdfPageCanvasProps

### Community 13 - "commands/metadata.rs"
Cohesion: 0.34
Nodes (13): clear_book_cover_override(), emit_changed(), get_book_metadata(), reset_book_metadata(), AppState, Book, BookMetadata, MetadataFields (+5 more)

### Community 14 - "dispatch"
Cohesion: 0.25
Nodes (8): dispatch(), parse_params(), RpcError, From, Result, Self, Value, T

### Community 15 - "mocks/bridge.ts"
Cohesion: 0.06
Nodes (56): App(), AppShell(), AppShellProps, ReaderSearchTab(), LibraryDataContext, AppDispatchContext, AppState, AppStateContext (+48 more)

### Community 16 - "PdfDocumentView.tsx"
Cohesion: 0.24
Nodes (10): PdfScrollTrackingOptions, PdfDocumentView(), PdfDocumentViewProps, LayoutSlot, PdfPageLifecycle, PdfPageSlot(), PdfPageSlotProps, PdfPageTextLayer() (+2 more)

### Community 17 - "ReaderShell.tsx"
Cohesion: 0.06
Nodes (60): annotationRects(), byKind(), DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_COLORS, HighlightColor, highlightCssColor(), isBookmarkAtLocator(), isBookmarkAtPage() (+52 more)

### Community 18 - "EpubError"
Cohesion: 0.27
Nodes (12): Attributes, attribute(), local_name(), EpubError, Error, String, parse_container_xml(), detect_fixed_layout() (+4 more)

### Community 19 - "mupdfWorker.ts"
Cohesion: 0.18
Nodes (8): ensureEngine(), methods, MupdfDocument, MupdfModule, TextLine, WorkerRequest, WorkerResponse, mupdf

### Community 21 - "import_paths"
Cohesion: 0.36
Nodes (9): ImportReport, import_paths(), reconnect_book(), AppState, Book, Result, String, Vec (+1 more)

### Community 22 - "library_locations.rs"
Cohesion: 0.36
Nodes (6): add_location(), list_locations(), Result, SqlitePool, String, Vec

### Community 23 - "vite.config.ts"
Cohesion: 0.40
Nodes (4): mupdfWasmUrl, wasmFile, @tailwindcss/vite, @vitejs/plugin-react

### Community 25 - "lib/bridge.ts"
Cohesion: 0.08
Nodes (58): EmptyLibraryState(), LibraryHeader(), PROGRESS_SAVE_DEBOUNCE_MS, ReaderProgressOptions, useReaderProgress(), AnnotationSnapshot, useAnnotations(), LoadedView (+50 more)

### Community 27 - "services/annotations.rs"
Cohesion: 0.07
Nodes (66): AnnotationRect, LibraryStats, Annotation, AnnotationKind, AnnotationPatch, AnnotationRect, NewAnnotation, DateTime (+58 more)

### Community 36 - "services/metadata.rs"
Cohesion: 0.14
Nodes (51): apply_source_metadata(), blank_title_is_rejected(), clean_list(), clean_optional(), clean_required(), clear_book_cover_override(), clearing_a_field_explicitly_overrides_it_to_empty(), cover_override_wins_and_survives_reimport() (+43 more)

### Community 38 - "lib.rs"
Cohesion: 0.16
Nodes (18): Debug, Mutex, RecommendedWatcher, app_data_dir(), AppState, covers_dir(), init_state(), pdfium_library_dirs() (+10 more)

### Community 41 - "AppShell.tsx"
Cohesion: 0.09
Nodes (41): BookDetail(), formatDate(), CollectionDialog(), Shell(), ItemButton(), ItemButtonProps, LIBRARY_ITEMS, Sidebar() (+33 more)

### Community 42 - "PdfReader.test.tsx"
Cohesion: 0.07
Nodes (32): estimatePageSizes(), PdfPage, makeAnnotation(), makeDomRect(), scrollTo(), stubScrollGeometry(), fireIntersection(), installMockIntersectionObserver() (+24 more)

### Community 43 - "book_importer.rs"
Cohesion: 0.09
Nodes (62): ProgressUpdate, init_pool(), init_pool_is_deterministic_and_idempotent(), Path, Result, SqlitePool, run_migrations(), schema_contains_all_core_tables() (+54 more)

### Community 52 - "ReadiumEpubHandle"
Cohesion: 0.09
Nodes (3): highlightTint(), ReadiumEpubHandle, ReadingProgressRecord

### Community 53 - "repository/books.rs"
Cohesion: 0.17
Nodes (38): count_books(), delete_book(), delete_cascades_to_reading_progress(), duplicate_path_violates_unique_constraint(), empty_title_is_rejected_by_check_constraint(), find_books_with_size(), find_id_by_path(), get_book() (+30 more)

### Community 54 - "session.rs"
Cohesion: 0.14
Nodes (33): books_without_toc_documents_read_without_a_toc(), build_manifest_json(), build_positions_json(), build_session(), builds_manifest_with_reading_order_and_toc(), builds_positions_across_spine(), clamp01(), container() (+25 more)

### Community 55 - "repository/metadata.rs"
Cohesion: 0.27
Nodes (21): apply_effective(), clear_overrides(), EffectiveValues, ensure_series(), get_overrides(), get_source_metadata(), json_list(), list_book_authors() (+13 more)

### Community 59 - "parse_epub"
Cohesion: 0.17
Nodes (28): empty_zip_reports_missing_mimetype(), mimetype_not_first_entry_reports_missing_mimetype(), missing_container_xml_reports_missing_container(), not_a_zip_reports_zip_error(), wrong_mimetype_reports_invalid_mimetype(), container_without_rootfile_reports_no_rootfile(), CoverImage, EpubBook (+20 more)

### Community 61 - "make-epub-fixtures.py"
Cohesion: 0.08
Nodes (30): build_all(), build_valid(), chapter_paragraph(), check(), emit_manifest(), main(), make(), _minimal_entries() (+22 more)

### Community 62 - "rpc.rs"
Cohesion: 0.18
Nodes (15): BookBytesArgs, BookIdArgs, BookResourceArgs, CollectionIdArgs, CollectionMemberArgs, CoverArgs, IdArgs, NameArgs (+7 more)

### Community 63 - "epub/readiumEngine.ts"
Cohesion: 0.07
Nodes (25): SerializedLocator, buildPositions(), EPUB_FONT_FAMILIES, EPUB_MIME_TYPE, EPUB_SCROLLED_SURFACE_MAX_PX, EpubAppearance, EpubFlow, EpubFontFamily (+17 more)

### Community 69 - "environment.ts"
Cohesion: 0.14
Nodes (18): killStaleProcesses(), libraryDir, prepareEnvironment(), pruneOldArtifacts(), pruneOldScratchDirs(), scratchDir, teardownEnvironment(), benchEpubFixture (+10 more)

### Community 70 - "frontend/package.json"
Cohesion: 0.08
Nodes (28): @types/node, typescript, license, name, private, type, version, clsx (+20 more)

### Community 77 - "helpers.ts"
Cohesion: 0.17
Nodes (28): bitmapCacheUsage(), canvasIsNonBlank(), clickUntilEffect(), closeReaderNavigation(), currentPageNumber(), epubHostCount(), epubSectionTotal(), firstPdfCanvas() (+20 more)

### Community 83 - "library_watcher.rs"
Cohesion: 0.06
Nodes (58): Duration, Event, EventKind, FnOnce, Formatter, Handle, OnChange, Output (+50 more)

### Community 84 - "index.ts"
Cohesion: 0.12
Nodes (24): APP_MIME_BY_EXTENSION, bookMime(), COVER_MIME_BY_EXTENSION, coverMime(), coversDir(), createWindow(), DEFAULT_STATE, loadWindowState() (+16 more)

### Community 89 - "package.json"
Cohesion: 0.06
Nodes (32): description, desktopName, devDependencies, electron, electron-builder, esbuild, prettier, @types/node (+24 more)

### Community 91 - "e2e/package.json"
Cohesion: 0.10
Nodes (20): devDependencies, electron, playwright, @playwright/test, tslib, @types/node, electron, @types/node (+12 more)

### Community 92 - "repository/reading_progress.rs"
Cohesion: 0.09
Nodes (41): book_collections, books, collections, reading_progress, annotations, authors, book_authors, book_metadata_overrides (+33 more)

### Community 94 - "ReaderNavigation.tsx"
Cohesion: 0.10
Nodes (26): COLOR_ORDER, ReaderAnnotationList(), ReaderAnnotationListProps, epubHrefJump(), flattenOutline(), flattenToc(), ReaderNavigation(), ReaderNavTab (+18 more)

### Community 96 - "library_scanner.rs"
Cohesion: 0.07
Nodes (63): Document, Object, PdfError, Error, String, build_pdf(), decode_pdf_string(), empty_title_field_falls_back_to_file_name() (+55 more)

### Community 101 - "epub/metadata.rs"
Cohesion: 0.20
Nodes (23): BytesStart, HashMap, calibre_series_fields_are_optional_and_tolerant(), detects_legacy_epub2_cover_meta(), EpubMetadata, handle_calibre_meta(), handle_itemref(), handle_legacy_cover_meta() (+15 more)

### Community 110 - "What You Must Do When Invoked"
Cohesion: 0.08
Nodes (24): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Honesty Rules, Interpreter guard for subcommands, Part A - Structural extraction for code files (+16 more)

### Community 111 - "repository/collections.rs"
Cohesion: 0.15
Nodes (31): Collection, CollectionSummary, NewCollection, DateTime, String, Utc, Vec, add_book_to_collection() (+23 more)

### Community 116 - "search.rs"
Cohesion: 0.16
Nodes (20): build_fts_query(), empty_query_is_invalid_input(), finds_books_by_description(), finds_books_by_isbn_and_by_file_name(), finds_books_by_publisher(), finds_books_by_title(), match_syntax_is_never_injected_through_user_input(), multi_term_query_requires_every_term() (+12 more)

### Community 117 - "devDependencies"
Cohesion: 0.09
Nodes (23): devDependencies, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, jsdom, shadcn (+15 more)

### Community 122 - "compilerOptions"
Cohesion: 0.09
Nodes (22): compilerOptions, baseUrl, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+14 more)

### Community 123 - "commands/annotations.rs"
Cohesion: 0.20
Nodes (18): AnnotationDto, AnnotationInput, AnnotationPatchInput, AnnotationRect, create_annotation(), delete_annotation(), list_annotations(), RectInput (+10 more)

### Community 124 - "4K scrolling performance — implementation plan"
Cohesion: 0.09
Nodes (21): 4K scrolling performance — implementation plan, Cross-cutting rules for every step, Dependencies, Phase 0 — Baseline + diagnostics (do first, ships with Phase 1), Phase 1 — Cap the render buffer (PDF-1 / PERF-1) — the primary fix, Phase 2 — Pixel-aware bitmap cache (PDF-2 / PERF-3), Phase 3 — Byte-budgeted live canvases + compositing hygiene (PDF-3 / PERF-4 + PERF-6), Phase 4 — Blit without realloc (PDF-3, small) (+13 more)

### Community 125 - "components.json"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 131 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, class-variance-authority, clsx, cn, @fontsource-variable/geist, lucide-react, mupdf, radix-ui (+9 more)

### Community 132 - "progressMigration.ts"
Cohesion: 0.14
Nodes (22): CfiStep, convertCfiStructure(), convertExact(), convertFoliateRow(), convertSpineElement(), convertSpineProgression(), cssPath(), elementChildren() (+14 more)

### Community 133 - "compilerOptions"
Cohesion: 0.13
Nodes (14): compilerOptions, allowJs, checkJs, lib, module, moduleResolution, noEmit, noFallthroughCasesInSwitch (+6 more)

### Community 134 - "ReaderAppearance.tsx"
Cohesion: 0.09
Nodes (26): FONT_FAMILY_OPTIONS, LAYOUT_OPTIONS, THEME_OPTIONS, GlobalSearch(), splitSnippet(), Popover(), PopoverAnchor(), PopoverContent() (+18 more)

### Community 143 - "resolve_zip_path"
Cohesion: 0.31
Nodes (9): normalize_path(), percent_decode(), resolve_zip_path(), String, resolve_nav_href(), Option, Value, split_fragment() (+1 more)

### Community 156 - "NewBook"
Cohesion: 0.13
Nodes (18): Book, book_serializes_with_camel_case_keys(), BookFormat, NewBook, DateTime, Error, Ok, Option (+10 more)

### Community 157 - "Stages"
Cohesion: 0.12
Nodes (15): Current state (verified), Decision points, Ground rules, Interaction model (binding), Plan: Bookshelf-inspired UI/UX architecture, Stage 0 — Foundations (complete), Stage 1 — Shell, navigation, shortcuts, Stage 2 — Library screen (+7 more)

### Community 158 - "4K scrolling performance — investigation handover"
Cohesion: 0.12
Nodes (15): 4K scrolling performance — investigation handover, Environment-1 — Silent slow paths in the GPU stack, EPUB-1 — Paginated turns rasterize viewport-sized CSS columns, EPUB-2 — Scrolled flow: whole-section iframe layers, Executive summary, External evidence, How to reproduce / measure, PDF-1 — No canvas resolution cap (primary) (+7 more)

### Community 163 - "artwork_cache.rs"
Cohesion: 0.28
Nodes (15): cover_files(), make_covers_dir(), Option, Path, PathBuf, Result, SqlitePool, String (+7 more)

### Community 164 - "Rendering"
Cohesion: 0.13
Nodes (14): Behavior, Continuous reader architecture (`frontend/src/components/reader/pdf/`), Error handling, Import mapping, In-book search, Outline, PDF layer, Public API (+6 more)

### Community 168 - "PdfPageCanvas.tsx"
Cohesion: 0.16
Nodes (17): blit(), PdfPageCanvas(), capByBytes(), effectiveRenderRatio(), MAX_ACTIVE_CANVAS_BYTES, MAX_RENDER_DIMENSION, MAX_RENDER_PIXELS, MAX_RENDER_PIXELS_HARD (+9 more)

### Community 175 - "services/reader.rs"
Cohesion: 0.31
Nodes (14): epub_book(), epub_error(), load_book_file(), load_book_file_range(), load_book_resource(), load_epub_session(), loads_the_stored_file_bytes_for_a_book_id(), missing_file_surfaces_as_an_io_error() (+6 more)

### Community 176 - "Tables"
Cohesion: 0.14
Nodes (14): annotations, book_collections, books, collections, Conventions, Database, Full-text search, library_locations (+6 more)

### Community 180 - "bench-reader.e2e.ts"
Cohesion: 0.16
Nodes (9): benchBookTitles, appendTrend(), BenchReport, DragResult, FrameStats, percentile(), report, summarize() (+1 more)

### Community 181 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, lib, module, moduleResolution, noEmit, noFallthroughCasesInSwitch, noUnusedLocals, skipLibCheck (+4 more)

### Community 186 - "AGENTS.md"
Cohesion: 0.17
Nodes (10): Branch state: Electron stack, Commands (in this order), Conventions, E2E for agents, External Knowledge & Source Research, graphify, Keep this file compact, Non-obvious gotchas (+2 more)

### Community 187 - "Testing"
Cohesion: 0.17
Nodes (12): Benchmark suite (headed, opt-in), E2E (Playwright against Electron), EPUB fixture corpus (three tiers), Frontend (Vitest + RTL), Headless on Linux (Xvfb), Isolation, cleanup, termination, Parallelism, Rules for agents (+4 more)

### Community 189 - "global-setup.ts"
Cohesion: 0.44
Nodes (7): armTeardownWatchdog(), globalSetup(), formatVersionBanner(), PkgVersion, requireFromE2e, stackVersions, writeEnvironmentRecord()

### Community 195 - "make-fixture.py"
Cohesion: 0.24
Nodes (10): build_pdf(), main(), Path, 64x64 solid sky-blue PNG built without external dependencies., Deterministic multi-page PDF: catalog, page tree, Info dictionary, one page…, Generate tests/fixtures/books/minimal.epub and minimal.pdf — tiny valid book…, tiny_png(), uniform_pages() (+2 more)

### Community 196 - "Coding standards"
Cohesion: 0.18
Nodes (10): Coding standards, Comments, Commits, Dependencies, Do not over-engineer, Frontend, Keep it small, Rust (+2 more)

### Community 197 - "AppError"
Cohesion: 0.18
Nodes (18): MigrateError, add_book_to_collection(), create_collection(), delete_collection(), list_collections(), remove_book_from_collection(), AppState, CollectionSummary (+10 more)

### Community 201 - "pdf/pdfEngine.ts"
Cohesion: 0.14
Nodes (16): usePdfSearch(), UsePdfSearchOptions, OutlineRow, EngineTextLine, getPdfPageText(), PdfRenderCancelledError, PendingRequest, resolveWasmUrl() (+8 more)

### Community 203 - "commands/reader.rs"
Cohesion: 0.32
Nodes (11): get_book_bytes(), get_book_resource(), get_epub_session(), GetBookBytesResult, GetBookResourceResult, GetEpubSessionResult, AppState, Option (+3 more)

### Community 204 - "Reader rendering (Readium TS Toolkit)"
Cohesion: 0.20
Nodes (10): Annotations, Engine seam, In-book search, Position locator, Progress migration (foliate → Readium), Reader rendering (Readium TS Toolkit), Resource loading, Security (+2 more)

### Community 207 - "commands/books.rs"
Cohesion: 0.33
Nodes (10): get_library_stats(), list_books(), remove_book(), AppState, Book, Result, SearchHit, String (+2 more)

### Community 210 - "extended_epub.rs"
Cohesion: 0.33
Nodes (9): conformance_corpus_imports_every_book(), corpus_dir(), epub_files(), exercise_corpus(), extended_corpus_imports_every_book(), Option, Path, PathBuf (+1 more)

### Community 211 - "Architecture"
Cohesion: 0.22
Nodes (9): Architecture, Database layer, EPUB layer, Frontend structure, PDF layer, Process and boundary, Rust module contract, Services (+1 more)

### Community 212 - "Reader performance — bench findings and handover"
Cohesion: 0.22
Nodes (8): Candidate next levers (ordered), Executive summary, Open questions, Reader performance — bench findings and handover, Rules of engagement (unchanged), The benchmark suite (what exists and how to use it), The measured record (Kubuntu Wayland, AMD + Mesa 26.0.8, 4K panel @ 60 Hz), What is NOT the bottleneck (measured, don't re-chase)

### Community 213 - "sweepProcesses"
Cohesion: 0.26
Nodes (11): killAll(), processExe(), processStarttime(), safeReadDir(), sweepProcesses(), [electronDist, sidecar], ownStart, parent (+3 more)

### Community 218 - "graphify reference: extra exports and benchmark"
Cohesion: 0.22
Nodes (8): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000)

### Community 219 - "epub_corpus.rs"
Cohesion: 0.44
Nodes (8): core_corpus_stays_small(), corpus_root(), malformed_core_fixtures_are_rejected_for_both_generations(), malformed_fixtures(), PathBuf, Vec, valid_core_fixtures_parse_for_both_generations(), valid_fixtures()

### Community 221 - "Build and dev environment"
Cohesion: 0.25
Nodes (7): Build and dev environment, Commands, Debug-build performance, E2E runtime, Electron bundles, Packaging (electron-builder), PDFium shared library (PDF covers)

### Community 222 - "Electron migration plan"
Cohesion: 0.18
Nodes (11): Electron migration plan, Phase 1 decisions and state (2026-09-07), Phase 4 decisions and state (2026-09-09), Phase 5 removals and packaging (2026-09-09), Phase 6 state (2026-09-09), Reading-progress migration (user data, must survive), Removal checklist (phase 5), Resource protocol (+3 more)

### Community 223 - "Performance budgets and metrics"
Cohesion: 0.25
Nodes (7): Budgets, How to measure, Legacy notes (WebKitGTK era, kept for context), Performance budgets and metrics, Reference conditions, Rules for changes, Touch-list

### Community 225 - "scripts"
Cohesion: 0.25
Nodes (8): scripts, build, dev, lint, preview, test, test:ci, typecheck

### Community 228 - ".handlePositionChanged"
Cohesion: 0.16
Nodes (3): asString(), clamp01(), serializeLocator()

### Community 231 - "TuxBooks"
Cohesion: 0.25
Nodes (8): Commands, Documentation, Getting started, Install, Layout, License, Stack, TuxBooks

### Community 232 - "ROADMAP.md"
Cohesion: 0.25
Nodes (7): Completed foundation, Current State, Milestone Completion Standard, Product Vision, Purpose, Recommended Execution Order, TuxBooks Milestones

### Community 233 - "Development Principles"
Cohesion: 0.25
Nodes (8): Avoid premature generalization, Development Principles, Local-first, No fake persistence, One subsystem at a time, Preserve working architecture, Real E2E matters, Tests are part of the feature

### Community 234 - "Milestone 6 — Bookmarks, Highlights, and Notes"
Cohesion: 0.25
Nodes (8): Bookmarks, Data model, Exit criteria, Goal, Highlights, Milestone 6 — Bookmarks, Highlights, and Notes, Notes, Reader UI

### Community 235 - "Milestone 4 — Covers and Artwork Pipeline"
Cohesion: 0.25
Nodes (8): Cache, EPUB, Exit criteria, Goal, Milestone 4 — Covers and Artwork Pipeline, PDF, Requirements, Testing

### Community 236 - "Scope"
Cohesion: 0.25
Nodes (8): EPUB engine, EPUB locator, EPUB reader, Exit criteria, Goal, Milestone 1 — Production EPUB Reader, Scope, Testing

### Community 237 - "Milestone 2 — PDF Navigation"
Cohesion: 0.25
Nodes (8): Exit criteria, Goal, Milestone 2 — PDF Navigation, Page thumbnails, PDF outline, Reader navigation, Scope, Testing

### Community 238 - "fetch-epub-extended.py"
Cohesion: 0.50
Nodes (7): already_cached(), extract(), fetch(), main(), Path, Fetch opt-in extended/conformance EPUB datasets (Tiers B and C). This is the…, sha256_file()

### Community 239 - "EPUB layer"
Cohesion: 0.29
Nodes (7): EPUB layer, Error handling, Fixtures, Known limitations (intentional, for now), Parsing stages, Public API, Rust import parser

### Community 240 - "Release and distribution"
Cohesion: 0.29
Nodes (6): AppImage specifics, Artifacts, Cutting a release, Deliberate deferrals, Release and distribution, The packaging gate

### Community 241 - "Webview frame clock and dpr fiction — findings"
Cohesion: 0.29
Nodes (6): Appendix — probe sources, Verdict 1 — the ~31 fps idle ceiling is WebKitGTK engine-level, Verdict 2 — dpr 2 is fiction; the true compositor scale is 1.45, Webview frame clock and dpr fiction — findings, What this changes in the handover's lever list, Why no clamp was implemented (decision)

### Community 247 - "Milestone 10 — Library and Reader UX Polish"
Cohesion: 0.29
Nodes (7): Accessibility, Desktop behavior, Exit criteria, Goal, Library, Milestone 10 — Library and Reader UX Polish, Reader

### Community 248 - "Milestone 7 — Metadata and Library Curation"
Cohesion: 0.29
Nodes (7): Architecture, Exit criteria, Goal, Metadata, Milestone 7 — Metadata and Library Curation, Normalized entities, Optional future operation

### Community 249 - "Milestone 3 — Filesystem Watcher and Library Reconciliation"
Cohesion: 0.29
Nodes (7): Exit criteria, Goal, Milestone 3 — Filesystem Watcher and Library Reconciliation, Missing files, Reconnection, Scope, Testing

### Community 250 - "BookMetadata"
Cohesion: 0.48
Nodes (6): BookMetadata, MetadataFields, MetadataOverridden, Option, String, Vec

### Community 252 - "epub-reader.e2e.ts"
Cohesion: 0.32
Nodes (5): currentSection(), engineFraction(), engineMovedPast(), openReadyEpub(), epubLocator()

### Community 253 - "electron-app.ts"
Cohesion: 0.12
Nodes (16): appArgs, deviceScaleFactor, launchElectronApp(), logLine(), patchEnvironmentRecord(), TestFixtures, versions, WorkerFixtures (+8 more)

### Community 257 - "graphify reference: query, path, explain"
Cohesion: 0.33
Nodes (5): For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal

### Community 258 - "Milestone 8 — Unified Reader Model"
Cohesion: 0.33
Nodes (6): Architecture, Document-specific position, Exit criteria, Goal, Milestone 8 — Unified Reader Model, Shared concepts

### Community 259 - "Milestone 9 — Reader Reliability and Performance Hardening"
Cohesion: 0.33
Nodes (6): Async lifecycle, Exit criteria, Goal, Memory, Milestone 9 — Reader Reliability and Performance Hardening, Test interactions

### Community 260 - "Milestone 11 — Release and Distribution"
Cohesion: 0.33
Nodes (6): CI, Exit criteria, Goal, Milestone 11 — Release and Distribution, Scope, Versioning policy (pre-1.0)

### Community 261 - "Milestone 5 — Search"
Cohesion: 0.33
Nodes (6): EPUB in-book search, Exit criteria, Goal, Library search, Milestone 5 — Search, PDF in-book search

### Community 263 - "ReadingProgress"
Cohesion: 0.38
Nodes (6): ProgressUpdate, ReadingProgress, DateTime, Option, String, Utc

### Community 274 - ".prettierrc.json"
Cohesion: 0.40
Nodes (4): printWidth, semi, singleQuote, trailingComma

### Community 276 - "Coverage gate"
Cohesion: 0.50
Nodes (3): Coverage gate, Outside the gate (and why), Required coverage by category

### Community 277 - "Confirming comment for WebKit bug 315997"
Cohesion: 0.50
Nodes (3): Comment text (copy everything inside the fence), Confirming comment for WebKit bug 315997, Follow-up comment — version A/B (paste only after the first comment)

### Community 282 - "graphify reference: add a URL and watch a folder"
Cohesion: 0.50
Nodes (3): For /graphify add, For --watch, graphify reference: add a URL and watch a folder

### Community 283 - "graphify reference: commit hook and native CLAUDE.md integration"
Cohesion: 0.50
Nodes (3): For git commit hook, For native CLAUDE.md integration, graphify reference: commit hook and native CLAUDE.md integration

### Community 284 - "graphify reference: incremental update and cluster-only"
Cohesion: 0.50
Nodes (3): For --cluster-only, For --update (incremental re-extraction), graphify reference: incremental update and cluster-only

### Community 285 - "coverage-gate.mjs"
Cohesion: 0.50
Nodes (3): byModule, cov, MODULES

### Community 296 - "useEpubDocument.ts"
Cohesion: 0.67
Nodes (3): EpubDocumentSnapshot, EpubDocumentState, EpubDocumentStatus

## Knowledge Gaps
- **602 isolated node(s):** `$schema`, `plugin`, `printWidth`, `semi`, `singleQuote` (+597 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 898 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **22 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AppError` connect `AppError` to `commands/metadata.rs`, `dispatch`, `EpubError`, `import_paths`, `library_locations.rs`, `services/annotations.rs`, `artwork_cache.rs`, `services/metadata.rs`, `book_importer.rs`, `services/reader.rs`, `repository/books.rs`, `repository/metadata.rs`, `rpc.rs`, `commands/reader.rs`, `commands/books.rs`, `library_watcher.rs`, `repository/reading_progress.rs`, `library_scanner.rs`, `repository/collections.rs`, `search.rs`, `commands/annotations.rs`?**
  _High betweenness centrality (0.085) - this node is a cross-community bridge._
- **Why does `react` connect `react` to `utils.ts`, `BookMetadataDialog.tsx`, `cn`, `usePdfDocument.ts`, `ReaderAppearance.tsx`, `PdfDocument`, `shortcuts.ts`, `PdfReader.tsx`, `mocks/bridge.ts`, `PdfDocumentView.tsx`, `ReaderShell.tsx`, `lib/bridge.ts`, `useEpubDocument.ts`, `AppShell.tsx`, `PdfPageCanvas.tsx`, `PdfReader.test.tsx`, `frontend/package.json`, `pdf/pdfEngine.ts`, `ReaderNavigation.tsx`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Why does `ReadiumEpubHandle` connect `ReadiumEpubHandle` to `EpubReader.test.tsx`, `.handlePositionChanged`, `useEpubDocument.ts`, `ReaderShell.tsx`, `epub/readiumEngine.ts`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `$schema`, `plugin`, `printWidth` to the rest of the system?**
  _602 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `utils.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0975609756097561 - nodes in this community are weakly interconnected._
- **Should `BookMetadataDialog.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.09634146341463415 - nodes in this community are weakly interconnected._
- **Should `EpubReader.test.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._