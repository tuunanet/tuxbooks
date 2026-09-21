# TuxBooks Roadmap

TuxBooks shipped its first public release (0.0.1) in September 2026 and is in active pre-1.0 development.

The focus is not on adding lots of new features. It is on making the existing experience **reliable, polished, and pleasant to use**.

## Now: 0.0.13

Release 0.0.13 rebuilt the PDF reader. It runs on PDFium compiled to WebAssembly instead of MuPDF.js, so the app no longer ships an AGPL-only dependency, and its zoom and scrolling follow GNOME Papers: wheel and pinch zoom hold the point under the pointer, page sizes round to whole pixels, deep zoom renders only the visible region, and the previous render stays on screen while the sharp one loads.

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
