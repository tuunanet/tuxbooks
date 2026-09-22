import { PdfRenderCancelledError, type PdfDocument, type SmartPalette } from "@/lib/pdf/pdfEngine";

/** A pre-render in flight: resolves with the finished buffer, cancels clean. */
export interface PdfPageBitmapRender {
  promise: Promise<HTMLCanvasElement>;
  cancel(): void;
}

/**
 * Rasterize one whole PDF page into a detached buffer at `ratio` device
 * pixels per CSS pixel.
 *
 * The off-viewport twin of `PdfPageCanvas`'s full-page path: identical
 * viewport, transform, and buffer sizing, so the bitmap it produces is the
 * one the canvas would have blitted had it been mounted. That equivalence is
 * what lets the presentation preload seed the shared bitmap cache under the
 * key the canvas looks up on arrival, turning a page step into a synchronous
 * blit instead of a fresh raster. No preview tier and no region clipping —
 * presentation fits the whole page, so its ratio never binds the region path.
 */
export function renderPdfPageBitmap(options: {
  document: PdfDocument;
  pageNumber: number;
  scale: number;
  ratio: number;
  smartColors?: SmartPalette;
}): PdfPageBitmapRender {
  const { document, pageNumber, scale, ratio, smartColors } = options;
  let cancelled = false;
  let task: { cancel(): void } | null = null;

  const promise = (async () => {
    const page = await document.getPage(pageNumber);
    // Superseded while getPage was in flight: do not start a raster.
    if (cancelled) throw new PdfRenderCancelledError();

    const viewport = page.getViewport({ scale });
    const buffer = globalThis.document.createElement("canvas");
    buffer.width = Math.floor(viewport.width * ratio);
    buffer.height = Math.floor(viewport.height * ratio);
    if (!buffer.getContext("2d")) throw new Error("Canvas 2D context is unavailable");

    const running = page.render({
      canvas: buffer,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      smartColors,
    });
    task = running;
    await running.promise;
    // Only the current generation may hand a buffer to the cache.
    if (cancelled) throw new PdfRenderCancelledError();
    return buffer;
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}
