# TuxBooks Roadmap

TuxBooks shipped its first public release (0.0.1) in September 2026 and is in active pre-1.0 development.

The focus is not on adding lots of new features. It is on making the existing experience **reliable, polished, and pleasant to use**.

## Now: 0.0.17

Release 0.0.13 rebuilt the PDF reader. It runs on PDFium compiled to WebAssembly instead of MuPDF.js, so the app no longer ships an AGPL-only dependency, and its zoom and scrolling follow GNOME Papers: wheel and pinch zoom hold the point under the pointer, page sizes round to whole pixels, deep zoom renders only the visible region, and the previous render stays on screen while the sharp one loads.

Release 0.0.14 followed with the fixes that surfaced in use: PDFs open again, a zoom holds its place instead of jumping or drifting, and deep zoom can no longer exhaust the PDFium heap (see `docs/adr/0004-pdf-region-render-budget.md`).

Release 0.0.15 aligns zoom anchoring with GNOME Papers: wheel and pinch follow the cursor, keyboard and toolbar hold the viewport center, typed and fit keep the relative position, and a page that fits the window stays put until it overflows.

Release 0.0.17 polishes the PDF reader: presentation mode pre-renders the next and previous pages so a flip blits instead of rasterizing behind a blank page, the reader title centers on the header, the presentation controls fade out until hovered or focused, and the page buffer matches the CSS box so deep zoom no longer resamples the whole canvas. It also caps a render bitmap before the worker builds its image, fixing a deep-zoom render failure. (0.0.16 was tagged but not published; 0.0.17 carries its changes.)

With the engine swap done, work continues in four areas.

### Core reliability

- Fix remaining library, import, synchronization, and persistence bugs
- Fix reader lifecycle and edge-case crashes
- Apply page rotation to PDF text selection, highlights, and outline navigation
- Keep reading progress and navigation reliable across restarts

### Reader polish

- Bring the PDF render p95 back within budget at high device pixel ratio
- Fix remaining navigation, search, annotation, and rendering edge cases
- Polish reader controls and interaction details

### Library polish

- Fix remaining grid/list/detail inconsistencies
- Polish collections, metadata editing, covers, and reading-progress UI
- Remove remaining rough edges and dead ends in the library experience

### Release readiness

- Keep the release pipeline green and the packaging gate passing
- Verify packaging and installation on supported Linux environments
- Cut the next release when the work above settles

## Later

Once the core experience is solid, development can move toward larger features and quality-of-life improvements.

Potential areas include:

- More powerful library organization
- Improved reading customization
- Additional ebook formats
- Better import and metadata workflows
- Performance improvements
- Accessibility and usability improvements

The roadmap is intentionally kept flexible. TuxBooks is developed incrementally, with **quality and a great reading experience taking priority over feature count**.
