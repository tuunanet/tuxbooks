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
 * Renders on the same canvas are serialized — a superseded task is cancelled
 * and given time to unwind before the next starts (PDF.js refuses concurrent
 * renders per canvas). Cancellation is expected control flow, never an error.
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
      const previous = taskRef.current;
      if (previous) {
        previous.cancel();
        await previous.promise.catch(() => {});
      }

      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;

      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context is unavailable");

      // `canvas` is the v6 render parameter; PDF.js acquires the 2D context
      // from it. The transform maps viewport units onto device pixels.
      const task = page.render({
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      taskRef.current = task;
      await task.promise;
      if (!cancelled) renderedRef.current?.(pageNumber);
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
