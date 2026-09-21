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
  const lines = await document.getTextLines(pageNumber);
  for (const line of lines) {
    const span = container.ownerDocument.createElement("span");
    span.textContent = line.text;
    span.style.left = `${line.x * scale}px`;
    span.style.top = `${line.y * scale}px`;
    span.style.width = `${Math.max(line.w, 1) * scale}px`;
    span.style.height = `${Math.max(line.h, 1) * scale}px`;
    span.style.fontSize = `${Math.min(line.size, line.h) * scale}px`;
    span.style.lineHeight = `${line.h * scale}px`;
    container.appendChild(span);
  }
  return {
    cancel: () => {
      container.textContent = "";
    },
  };
}
