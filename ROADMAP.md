# TuxBooks Roadmap

TuxBooks shipped its first public release (0.0.1) in September 2026 and its first minor release (0.1.0) in October 2026. The basic functionality is in place: a local-first library and readers for EPUB and PDF that hold up to daily use.

The focus is not on adding lots of new features. It is on making the existing experience **reliable, polished, and pleasant to use**.

## Now: after 0.1.0

Three milestones come next.

### Syncing data

- Keep reading progress, bookmarks, and highlights in sync across machines
- Decide the sync transport and the conflict rules before building anything
- Keep the local-first promise: the library stays usable with no network

### Improving architecture

- Untangle the reader, library, and settings layers so a change stops rippling
- Pay down the debt left by the engine swap and the watched-folder rewrite
- Make the sidecar's boundaries explicit so features stop reaching across them

### Optimizing performance

- Bring the PDF render p95 back within budget at high device pixel ratio
- Cut import and startup time for large libraries
- Remove the remaining jank from scrolling and reflow

## Recent releases

Release 0.0.13 rebuilt the PDF reader. It runs on PDFium compiled to WebAssembly instead of MuPDF.js, so the app no longer ships an AGPL-only dependency, and its zoom and scrolling follow GNOME Papers: wheel and pinch zoom hold the point under the pointer, page sizes round to whole pixels, deep zoom renders only the visible region, and the previous render stays on screen while the sharp one loads.

Release 0.0.14 followed with the fixes that surfaced in use: PDFs open again, a zoom holds its place instead of jumping or drifting, and deep zoom can no longer exhaust the PDFium heap (see `docs/adr/0004-pdf-region-render-budget.md`).

Release 0.0.15 aligns zoom anchoring with GNOME Papers: wheel and pinch follow the cursor, keyboard and toolbar hold the viewport center, typed and fit keep the relative position, and a page that fits the window stays put until it overflows.

Release 0.0.17 polishes the PDF reader: presentation mode pre-renders the next and previous pages so a flip blits instead of rasterizing behind a blank page, the reader title centers on the header, the presentation controls fade out until hovered or focused, and the page buffer matches the CSS box so deep zoom no longer resamples the whole canvas. It also caps a render bitmap before the worker builds its image, fixing a deep-zoom render failure. (0.0.16 was tagged but not published; 0.0.17 carries its changes.)

Release 0.0.18 adds a Data tab in Settings. It shows where TuxBooks keeps its own data, how large each piece is, and the folders it watches, and it clears only the caches the app rebuilds on its own; the catalog, the cover cache, your settings, and your books stay. A failed start is no longer silent: the app writes a startup log, shows a dialog, and prints the resolved paths and a recovery command, and a database that cannot open is quarantined under a timestamped name and replaced with a fresh one instead of being deleted. `--reset-data` and `--dry-run` cover recovery from a terminal, and neither ever touches book files.

Release 0.0.19 makes the reader usable without a mouse and names the books the app is not reconciling. The PDF page number is an editable field in the toolbar and the presentation bar: type a page to jump, step with the wheel or arrow keys while it is focused. Shortcuts open the thumbnails sidebar, the appearance panel, and the contents drawer (including its Bookmarks and Highlights tabs), Settings lists every shortcut from one source, and the docs match. Books outside every watched folder get their own Outside Watched Folders view; the Data tab counts them and jumps there, and Copy path works again. The CLI gains `--help` and `--version` and rejects unknown flags.

Release 0.0.20 makes the watched folders the single source of truth for the library. Settings gains a Folders section that lists the watched folders, marks one missing from disk, and adds or removes them. Unwatching removes that folder's books from the catalog through the same cascade Remove uses, so reading progress and annotations go with them while files on disk stay untouched. The library mirrors the watch list exactly: importing a single file watches its folder, a one-time migration purges books outside every watched folder, and the loose-books mechanism 0.0.19 introduced is retired from the UI and the wire. The library gains multi-select with a selection bar and bulk remove, collection, and mark-as-finished actions, Settings gains an About tab, and an import's completing refresh now wins over buffered import events.

Release 0.1.0 marks the first minor version. The basic functionality is in place: the library indexes a folder of EPUB and PDF books, remembers where you stopped reading, and keeps everything on your machine. Bookmarks and highlights work in both readers, a bookmark can be named the moment it is placed, and book detail lists every bookmark and highlight with a jump back to its spot. The reader navigation sits on the right, in-book search opens with Ctrl+F, and watched folders are the single source of truth for the library.

## Later

Once syncing, architecture, and performance settle, development can move toward larger features.

The two biggest ideas on the table:

- **Local RAG powered search across all library documents.** Index the text of every book and answer questions from it, with embeddings and retrieval running on your own machine. No cloud, no upload.
- **CLI or MCP for agents.** Expose the library to scripts and coding agents, so a book's metadata, notes, and highlights can be read and organized from outside the app.

Beyond those:

- More powerful library organization
- Improved reading customization
- Additional ebook formats
- Better import and metadata workflows
- Accessibility and usability improvements
