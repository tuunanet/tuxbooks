import { useEffect, useRef } from "react";
import {
  RenderingCancelledException,
  type PdfDocument,
  type PdfRenderTask,
} from "@/lib/pdf/pdfEngine";

interface PdfPageCanvasProps {
  document: PdfDocument;
  pageNumber: number;
  /** Displayed size in CSS pixels; the backing store is devicePixelRatio-aware. */
  width: number;
  height: number;
  /** PDF.js render scale (displayed pixels / page units). */
  scale: number;
  onPageRendered?: (pageNumber: number) => void;
  onPageError?: (pageNumber: number, error: unknown) => void;
}

/**
 * Imperative page renderer: draws one page into one canvas at a fixed size.
 *
 * Every render paints into a private offscreen buffer; the visible canvas is
 * only ever touched by the final one-shot blit of a completed render. This
 * makes the visible canvas single-writer: a superseded or cancelled render
 * task unwinds into its own discarded buffer and can never interleave its
 * paint loop with the current one on shared canvas state — without this,
 * rapid supersession (fast scrollbar drags, zoom, geometry corrections)
 * produced mirrored/offset page fragments on WebKitGTK. Superseded
 * instances never even start (cancellation checkpoints) and never blit.
 * Cancellation is expected control flow, never an error.
 */
export function PdfPageCanvas({
  document,
  pageNumber,
  width,
  height,
  scale,
  onPageRendered,
  onPageError,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<PdfRenderTask | null>(null);

  const renderedRef = useRef(onPageRendered);
  useEffect(() => {
    renderedRef.current = onPageRendered;
  });
  const errorRef = useRef(onPageError);
  useEffect(() => {
    errorRef.current = onPageError;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    (async () => {
      // Stop the previous generation's work early; it renders into its own
      // buffer, so there is no shared state to wait for.
      taskRef.current?.cancel();

      const page = await document.getPage(pageNumber);
      // Checkpoint 1: this instance may have been superseded while getPage
      // was in flight; do not start work at all.
      if (cancelled) return;

      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;

      const buffer = canvas.ownerDocument.createElement("canvas");
      buffer.width = Math.floor(viewport.width * ratio);
      buffer.height = Math.floor(viewport.height * ratio);
      const bufferContext = buffer.getContext("2d");
      if (!bufferContext) throw new Error("Canvas 2D context is unavailable");

      // PDF.js acquires the context from `canvas`; the transform maps
      // viewport units onto device pixels.
      const task = page.render({
        canvas: buffer,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      taskRef.current = task;
      await task.promise;

      // Checkpoint 2: only the current generation may touch the canvas.
      if (cancelled) return;
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      context?.drawImage(buffer, 0, 0);

      renderedRef.current?.(pageNumber);
    })().catch((err: unknown) => {
      if (cancelled || err instanceof RenderingCancelledException) return;
      errorRef.current?.(pageNumber, err);
    });

    return () => {
      cancelled = true;
      taskRef.current?.cancel();
    };
  }, [document, pageNumber, width, height, scale]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="pdf-canvas"
      data-pdf-page={pageNumber}
      className="block rounded-sm border bg-white shadow-sm"
    />
  );
}
