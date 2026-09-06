import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { normalizePdfOutline } from "./pdfOutline";
import { assemblePageText, type PdfTextItem } from "./pdfSearch";

/**
 * The single seam between the app and the PDF.js engine. Components depend on
 * these re-exported types and helpers only, never on pdfjs-dist directly, so
 * the engine stays swappable and unit tests can mock one module.
 *
 * The library itself loads lazily on the first document open: PDF is one
 * reader format among several, and a static import would put PDF.js into the
 * entry chunk of every launch. The `?url` worker import stays static — it
 * only emits an asset reference, never the library.
 */

let engine: Promise<typeof import("pdfjs-dist")> | null = null;
let renderingCancelledExceptions: (new (message?: string) => unknown)[] | undefined;

/**
 * Load PDF.js once. Concurrent callers share one in-flight import; a failure
 * resets the cache so a transient asset error can be retried by the next
 * open attempt instead of poisoning the session.
 */
function loadEngine(): Promise<typeof import("pdfjs-dist")> {
  engine ??= import("pdfjs-dist").then(
    (pdfjs) => {
      // The worker must be configured before any document can open; the
      // only path to pdfjs goes through this resolved promise.
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      // Render tasks reject with RenderingCancelledException; pdf.js v6's
      // TextLayer instead rejects with the base AbortException. Both mean
      // "aborted" — expected control flow, never an error.
      renderingCancelledExceptions = [pdfjs.RenderingCancelledException, pdfjs.AbortException];
      return pdfjs;
    },
    (err: unknown) => {
      engine = null;
      throw err;
    },
  );
  return engine;
}

export type PdfDocument = PDFDocumentProxy;
export type PdfPage = PDFPageProxy;
export type PdfRenderTask = RenderTask;

/** Configured worker URL; diagnostics for fake-worker fallback detection. */
export function pdfWorkerSrc(): string {
  return workerUrl;
}

/**
 * True when a failure is a cancellation (superseded render, page left the
 * virtualization window, text-layer task cancelled) rather than a real
 * error. Cancellation classes only exist once the engine has loaded, so the
 * lazily captured list is always set by then.
 */
export function isRenderingCancelled(error: unknown): boolean {
  return renderingCancelledExceptions?.some((cls) => error instanceof cls) ?? false;
}

/**
 * Open a PDF from in-memory bytes. Note: PDF.js transfers the underlying
 * buffer to its worker, so callers must not reuse the array afterwards.
 */
export async function openPdfDocument(data: Uint8Array): Promise<PdfDocument> {
  const { getDocument } = await loadEngine();
  return getDocument({ data }).promise;
}

/** Release a document's worker and parsing resources. */
export async function closePdfDocument(document: PdfDocument): Promise<void> {
  await document.loadingTask.destroy();
}

/**
 * The document's outline (table of contents) with every destination
 * resolved to a 1-based page. Documents without an outline normalize to an
 * empty list. Normalization lives in pdfOutline.ts (pure, unit-tested
 * without the engine); this re-export keeps components on the seam.
 */
export function getPdfOutline(document: PdfDocument) {
  return normalizePdfOutline(document);
}
export type { PdfOutlineItem } from "./pdfOutline";

/**
 * Assembled plain text of one page (PDF.js text content), for in-book
 * search. Items are joined at their boundaries so queries match across
 * line breaks like they read in the rendered page. Assembly itself is a
 * pure function in pdfSearch.ts (unit-tested without the engine).
 */
export async function getPdfPageText(document: PdfDocument, pageNumber: number): Promise<string> {
  const page: PDFPageProxy = await document.getPage(pageNumber);
  const content = await page.getTextContent();
  return assemblePageText(content.items as PdfTextItem[]);
}

export { findPageMatches, type PdfSearchExcerpt } from "./pdfSearch";

/**
 * Renders one page's text layer into `container` (positioned over the page
 * canvas by the caller). The layer is what makes PDF text selectable, so
 * highlights can be created from real user selections; it carries no visuals
 * of its own (transparent text spans). Failures are non-fatal: a page
 * without a text layer simply cannot be selected.
 *
 * The caller owns lifecycle: cancel when the page leaves the render set.
 * Requires the `--scale-factor` CSS custom properties on an ancestor (set by
 * the page slot wrapper).
 */
export async function renderPdfTextLayer(
  document: PdfDocument,
  pageNumber: number,
  container: HTMLElement,
  scale: number,
): Promise<{ cancel(): void }> {
  const { TextLayer } = await loadEngine();
  const page = await document.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale });
  const layer = new TextLayer({ textContentSource: textContent, container, viewport });
  void layer.render().catch((err: unknown) => {
    // Cancellation is expected control flow (page superseded or unmounted
    // mid-render — the same rule PdfPageCanvas applies); only real failures
    // are worth a console warning.
    if (isRenderingCancelled(err)) return;
    console.warn(`text layer render failed on page ${pageNumber}`, err);
  });
  return { cancel: () => layer.cancel() };
}
