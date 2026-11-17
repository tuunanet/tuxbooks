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
  // Measuring before the app font loads bakes in stale metrics.
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
    // PDFium char boxes exceed the gap between line tops; pin line-height to
    // that gap or the selection band overlaps the next line.
    const boxHeight = Math.max(line.h, 1) * scale;
    const bandHeight = Math.min(boxHeight, linePitch(index) * scale);
    // The painted band is the larger of line box and glyph box (~1.3x font).
    const fontHeight = Math.min(boxHeight, bandHeight * 0.7);
    span.style.left = `${line.x * scale}px`;
    span.style.top = `${line.y * scale + (boxHeight - bandHeight) / 2}px`;
    span.style.height = `${boxHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.lineHeight = `${bandHeight}px`;
    container.appendChild(span);
    spans.push(span);
  }
  // Hit-testing runs in span text-layout space: PDFs can report ~1pt for a
  // 12pt line, and a transform scales box and run together, so fit the width
  // with letter-spacing; fit again on resize if the container had no layout.
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
      // Remove only this build's spans: the container is shared across effect
      // re-runs (StrictMode), so a superseded build must not wipe the live one.
      for (const span of spans) span.remove();
    },
  };
}
