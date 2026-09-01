import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { RenderingCancelledException } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * The single seam between the app and the PDF.js engine. Components depend on
 * these re-exported types and helpers only, never on pdfjs-dist directly, so
 * the engine stays swappable and unit tests can mock one module.
 */

// Parsing and rasterization run off the UI thread in the bundled worker; the
// `?url` import makes Vite emit it as a static asset in dev and built apps.
GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDocument = PDFDocumentProxy;
export type PdfPage = PDFPageProxy;
export type PdfRenderTask = RenderTask;
export { RenderingCancelledException };

/** Configured worker URL; diagnostics for fake-worker fallback detection. */
export function pdfWorkerSrc(): string {
  return GlobalWorkerOptions.workerSrc;
}

/**
 * Open a PDF from in-memory bytes. Note: PDF.js transfers the underlying
 * buffer to its worker, so callers must not reuse the array afterwards.
 */
export async function openPdfDocument(data: Uint8Array): Promise<PdfDocument> {
  return getDocument({ data }).promise;
}

/** Release a document's worker and parsing resources. */
export async function closePdfDocument(document: PdfDocument): Promise<void> {
  await document.loadingTask.destroy();
}
