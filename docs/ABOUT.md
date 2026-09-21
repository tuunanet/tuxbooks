## What this project is

Local-first desktop ebook library (bookshelf style). **Rust is the
application/domain language; React/TypeScript is only the presentation
layer; Chromium (via Electron) is the sole desktop web runtime.**

- Business logic in Rust (`domain/`, `services/`), UI logic in TypeScript, SQL
  only in `repository/` — boundaries and process model: `docs/ARCHITECTURE.md`.
- Electron `main`/`preload` are plumbing only; the renderer never sees Node.js.
  The Rust sidecar (`sidecar/`) owns DB, filesystem, scanner, and metadata.
- Reader engines behind single-module seams: only
  `frontend/src/lib/epub/readiumEngine.ts` imports Readium, and only the PDF
  engine adapters under `frontend/src/lib/pdf/` import PDFium; components use
  the format-agnostic `Reader` abstraction (`docs/EPUB.md` / `docs/PDF.md`).
- Do not silently change these architectural conventions.
