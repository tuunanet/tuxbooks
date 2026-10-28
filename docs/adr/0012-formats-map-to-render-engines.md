# ADR 0012: Formats map to engines through a registry

Status: accepted
Date: 2026-10-28
Decides: how the app separates "what a book file is" from "which reader draws it", and how far the EPUB reader and the PDF reader are expected to generalize
Relates to: spec `tuxbooks-u67`, deferred capability work `tuxbooks-9xk`, [FORMATS.md](../FORMATS.md), [EPUB.md](../EPUB.md), [PDF.md](../PDF.md)

## Context

The library supported two formats and said so in the sidebar: EPUBs and PDFs
were navigation entries, and the reader picked a view with
`isEpub ? <EpubReader> : <PdfReader>`. Both scale badly.

A sidebar entry per format makes every new format a navigation change, and it
turns format into a place you can be rather than a filter you apply. PDFs that
are in progress, or a collection narrowed to one format, cannot be expressed.
The header already had a sort control, so the filter belongs beside it.

The reader choice also conflated two facts. A _format_ is what the file is,
decided from the extension at import. An _engine_ is which reader draws it,
and one engine can serve several formats. The EPUB reader is built on Readium
and reuses for other reflowable formats with moderate work: those need an
import-time normalization step, not a second rendering path. The PDF reader is
built around PDFium and the PDF page model specifically. It is single-format
by decision, and generalizing it would cost the view-geometry work recorded in
ADRs 0003 and 0004.

## Decision

1. Format filtering is a multi-select filter in the library header, not a
   sidebar section. It composes with every section and collection, and an
   empty selection means every format.
2. The frontend owns a format registry (`frontend/src/lib/formats.ts`): each
   supported `BookFormat` maps to a display label and a `RenderEngine`
   (`readium` or `pdfium`). The filter's options and `ReaderShell`'s engine
   choice both read it.
3. The sidecar owns file-kind truth and never names an engine. `BookFormat`
   stays the closed set of supported formats, and `BookFormat::from_path`
   returns `None` for an unsupported extension instead of guessing EPUB.
4. The Readium engine generalizes: a new EPUB-family format is normalized to
   EPUB at import and reuses the viewer unchanged. The PDFium engine does not:
   a new fixed-layout format gets its own engine.
5. Engine-specific checks inside the reader stay as they are for now. New
   format-specific behavior must read the registry instead of branching on
   `book.format`.

## Considered options

- **A "Formats" group in the sidebar instead of a header dropdown.** Keeps the
  navigation shape, but still cannot compose with In Progress or a collection.
- **A capability table on every format now** (reflowable, has-toc,
  can-highlight, ...). There is one reflowable format to validate it against,
  and the existing `isPdf` checks would migrate to flags nothing can exercise
  yet.
- **A single generic reader with per-format adapters.** Wrong for PDF: the page
  model, view geometry, and render budget are PDF-specific, and hiding them
  behind a generic interface would make the PDF path harder to reason about.

## Consequences

- The sidebar no longer has a destination per format; format is a filter.
- Adding a format is a registry entry plus an import path, not a navigation
  entry and a new reader branch.
- `BookFormat::from_path` callers handle `None`. Stored rows always have a
  supported extension, so the serializer treats `None` as an error rather than
  mislabeling the book.
- Deferred: the reader's scattered `isPdf`/`isEpub` checks still branch on
  format (`tuxbooks-9xk`). Revisit when a second reflowable format is scoped,
  because that is when the capability set becomes knowable.
- The onboarding checklist lives in [FORMATS.md](../FORMATS.md).
