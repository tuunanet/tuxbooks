import { normalizePdfOutline, type PdfOutlineItem } from "./pdfOutline";
import { assemblePageText, type PdfTextItem } from "./pdfSearch";
import type { PdfDocument } from "./pdfEngineTypes";
import {
  cancelPdfiumPrewarm,
  openPdfiumDocument,
  openPdfiumDocumentFromBook,
  pdfiumWorkerSrc,
  prewarmPdfiumEngine,
} from "./pdfiumEngine";
import type { BookFormat } from "@/types/domain";

export { PdfRenderCancelledError, isRenderingCancelled } from "./pdfEngineTypes";
export type { EngineTextLine, PdfDocument, PdfPage, PdfRenderTask } from "./pdfEngineTypes";

/**
 * The single seam between the app and the PDF engine (ADR 0002). Components
 * depend on these re-exported types and helpers only, never on the engine
 * package, so the engine stays swappable and unit tests can mock one module.
 *
 * PDFium-WASM is the only engine: this module renames the adapter's entry
 * points onto the seam's stable public surface, so reader components stay
 * engine-agnostic. The adapter (`pdfiumEngine.ts`) talks to
 * `pdfiumWorker.ts`, which owns the WASM engine.
 *
 * Page geometry is in PDF page units (points) at scale 1: `getViewport({
 * scale })` returns CSS pixels, renders address the backing store through
 * the transform ratio.
 */

/** Configured worker URL; diagnostics for the E2E worker-load assertion. */
export function pdfWorkerSrc(): string {
  return pdfiumWorkerSrc();
}

/**
 * Load the PDFium module into a spare worker ahead of any document open.
 * Safe to call repeatedly (single-flight); never throws into app startup — a
 * failed prewarm just discards the spare worker, and the next open pays the
 * cold start instead. Runs without opening a document or rasterizing.
 */
export function prewarmPdfEngine(): Promise<void> {
  return prewarmPdfiumEngine();
}

/**
 * Cancel an in-flight prewarm that was never adopted (reader closed before
 * any open, test teardown). Terminating a spare worker is free; a worker
 * already adopted by a document is left alone.
 */
export function cancelPdfPrewarm(): void {
  cancelPdfiumPrewarm();
}

/**
 * Open a PDF from in-memory bytes. The underlying buffer is transferred to
 * the document's worker, so callers must not reuse the array afterwards.
 */
export function openPdfDocument(data: Uint8Array): Promise<PdfDocument> {
  return openPdfiumDocument(data);
}

/**
 * Open a stored book's PDF without ever loading the whole file into the
 * renderer: the worker opens the document through
 * `FPDF_LoadCustomDocument` + `FPDF_FILEACCESS` over `tuxbooks://book/<id>`
 * and pulls only the ranges it needs (xref trail, then page 1 content), so
 * the full-file transfer leaves the first-page critical path entirely.
 */
export function openPdfDocumentFromBook(bookId: number, format: BookFormat): Promise<PdfDocument> {
  return openPdfiumDocumentFromBook(bookId, format);
}

/** Terminate a document's worker and release every WASM resource. */
export async function closePdfDocument(document: PdfDocument): Promise<void> {
  await document.destroy();
}

/**
 * The document's outline (table of contents) with every destination
 * resolved to a 1-based page. Documents without an outline normalize to an
 * empty list. Normalization lives in pdfOutline.ts (pure, unit-tested
 * without the engine); this re-export keeps components on the seam.
 */
export async function getPdfOutline(document: PdfDocument): Promise<PdfOutlineItem[]> {
  return normalizePdfOutline(await document.getOutline());
}
export type { PdfOutlineItem } from "./pdfOutline";

/**
 * Assembled plain text of one page (structured text lines), for in-book
 * search. Lines are joined at their boundaries so queries match across line
 * breaks like they read in the rendered page. Assembly itself is a pure
 * function in pdfSearch.ts (unit-tested without the engine).
 */
export async function getPdfPageText(document: PdfDocument, pageNumber: number): Promise<string> {
  const lines = await document.getTextLines(pageNumber);
  const items: PdfTextItem[] = lines.map((line) => ({ str: line.text, hasEOL: true }));
  return assemblePageText(items);
}

export { findPageMatches, type PdfSearchExcerpt } from "./pdfSearch";

/** Dark colour-scheme palette, re-exported through the seam. */
export type { SmartPalette } from "./smartColors";

/**
 * Renders one page's text layer into `container` (positioned over the page
 * canvas by the caller): transparent spans positioned in page-unit space at
 * the given scale, built from the engine's structured-text lines. The layer
 * is what makes PDF text selectable, so highlights can be created from real
 * user selections; it carries no visuals of its own. Failures are
 * non-fatal: a page without a text layer simply cannot be selected.
 */
export async function renderPdfTextLayer(
  document: PdfDocument,
  pageNumber: number,
  container: HTMLElement,
  scale: number,
): Promise<{ cancel(): void }> {
  let cancelled = false;
  // The run measurements below depend on the app font, which loads
  // asynchronously; measuring before the swap bakes in stale metrics. Wait
  // for the font set to settle (bounded — the layer is an affordance, never
  // worth blocking on), and honor a cancel that lands during the wait.
  const fonts = container.ownerDocument.fonts;
  if (fonts !== undefined && fonts.status === "loading") {
    await Promise.race([fonts.ready, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  if (cancelled) return { cancel: () => {} };
  const lines = await document.getTextLines(pageNumber);
  if (cancelled) return { cancel: () => {} };
  /** Distance to the nearest other line top, in page units. */
  const linePitch = (index: number): number => {
    const y = lines[index]!.y;
    let pitch = Infinity;
    for (let other = 0; other < lines.length; other++) {
      if (other === index) continue;
      const dy = Math.abs(lines[other]!.y - y);
      if (dy > 0.5) pitch = Math.min(pitch, dy);
    }
    return pitch === Infinity ? lines[index]!.h : pitch;
  };
  const spans: HTMLSpanElement[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const span = container.ownerDocument.createElement("span");
    span.textContent = line.text;
    // Native selection bands follow the inline line box, not the font: a
    // small font still paints a band the height of line-height. PDFium's
    // char boxes carry ascent and descent and usually exceed the distance
    // between line tops, so a band as tall as the box overlaps the next
    // line. Pin line-height to the gap to the neighbouring line (never more
    // than the box) and nudge the box down by the difference, keeping the
    // band centred on the text row.
    const boxHeight = Math.max(line.h, 1) * scale;
    const bandHeight = Math.min(boxHeight, linePitch(index) * scale);
    // The painted band is the larger of the line box and the font's glyph
    // box (~1.3x the font size), so both have to fit the pitch.
    const fontHeight = Math.min(boxHeight, bandHeight * 0.7);
    span.style.left = `${line.x * scale}px`;
    span.style.top = `${line.y * scale + (boxHeight - bandHeight) / 2}px`;
    span.style.height = `${boxHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.lineHeight = `${bandHeight}px`;
    container.appendChild(span);
    spans.push(span);
  }
  // Selection hit-testing works in the span's text-layout space, so the text
  // run must span the line's char-box width. Two things get in the way. The
  // reported font size cannot be trusted: some PDFs carry degenerate text
  // matrices (a 12pt line reporting ~1pt), which lays the text out into a
  // sliver of the line and collapses every mouse drag to a caret. And a
  // transform cannot fix sizing: scaling the span scales its box and its run
  // together, leaving their ratio untouched. The font comes from the
  // char-box height, and the width is fitted with letter-spacing — a purely
  // horizontal adjustment — so every x in the hit area maps to a character.
  //
  // The layer can mount before the page slot has layout (a restored
  // position builds it during reader initialization, and StrictMode
  // double-mounts in dev), where the Range measures zero and a one-shot fit
  // would silently leave the run at pass-1 sizing. Measure after the first
  // frame, and if the container still has no layout, fit the moment it gets
  // some.
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 16);
      }
    });
  let fittedOnce = false;
  const fitToLineWidths = (): boolean => {
    if (fittedOnce) return true;
    const widths = spans.map((span) => {
      const range = container.ownerDocument.createRange();
      range.selectNodeContents(span);
      // jsdom's Range cannot measure geometry; no measurement, no fit.
      const width = range.getBoundingClientRect?.()?.width ?? 0;
      range.detach();
      return width;
    });
    let measurable = false;
    for (let i = 0; i < spans.length; i++) {
      const natural = widths[i]!;
      if (natural < 1) continue;
      measurable = true;
      const boxWidth = Math.max(lines[i]!.w, 1) * scale;
      const spacing = (boxWidth - natural) / Math.max(lines[i]!.text.length, 1);
      spans[i]!.style.letterSpacing = `${spacing}px`;
      spans[i]!.dataset.pdfTextFitted = "true";
    }
    fittedOnce = measurable;
    return measurable;
  };

  await nextFrame();
  if (cancelled) return { cancel: () => {} };
  fitToLineWidths();
  let layoutObserver: ResizeObserver | null = null;
  if (!fittedOnce && spans.length > 0 && typeof ResizeObserver === "function") {
    layoutObserver = new ResizeObserver(() => {
      if (fitToLineWidths()) {
        layoutObserver?.disconnect();
        layoutObserver = null;
      }
    });
    layoutObserver.observe(container);
  }

  return {
    cancel: () => {
      cancelled = true;
      layoutObserver?.disconnect();
      layoutObserver = null;
      // Remove only this build's spans. The layer container is shared across
      // effect re-runs (StrictMode mounts twice in dev), so a superseded
      // build resolving late must never wipe the live build's spans; a
      // container-wide clear here left dev-mode layers empty until the next
      // layout change forced a rebuild.
      for (const span of spans) span.remove();
    },
  };
}
