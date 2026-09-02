import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { normalizePdfOutline } from "./pdfOutline";

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
let renderingCancelledException:
  (typeof import("pdfjs-dist"))["RenderingCancelledException"] | undefined;

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
      renderingCancelledException = pdfjs.RenderingCancelledException;
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
 * True when a render failure is a cancellation (superseded render, page left
 * the virtualization window) rather than a real error. Renders only exist
 * once the engine has loaded, so the lazily captured class is always set.
 */
export function isRenderingCancelled(error: unknown): boolean {
  return renderingCancelledException !== undefined && error instanceof renderingCancelledException;
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
