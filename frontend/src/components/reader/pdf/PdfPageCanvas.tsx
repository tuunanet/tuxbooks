import { useEffect, useRef } from "react";
import { isRenderingCancelled, type PdfDocument, type PdfRenderTask } from "@/lib/pdf/pdfEngine";
import { effectiveRenderRatio } from "./pdfRenderPolicy";
import type { PdfBitmapCache } from "./pdfBitmapCache";

interface PdfPageCanvasProps {
  document: PdfDocument;
  pageNumber: number;
  /**
   * Displayed size in CSS pixels; the backing store is rendered at the
   * effective ratio (pdfRenderPolicy) — dpr, capped by the PERF-1 pixel
   * and dimension budgets, with CSS upscaling beyond the cap.
   */
  width: number;
  height: number;
  /** Render scale (displayed pixels / page units). */
  scale: number;
  /**
   * Two-stage first paint: render a readable preview at ratio ≤ 1, blit it,
   * then refine to the full effective ratio in the background (§ first
   * readable page). Only worth passing while the very first page of a
   * freshly opened document is pending — every later render should just be
   * final quality.
   */
  preview?: boolean;
  /**
   * Shared per-document bitmap cache (§ rendering policy). A hit blits the
   * retained bitmap synchronously — no engine work; a completed render
   * stores its offscreen buffer so a future re-entry can do the same.
   */
  bitmapCache?: PdfBitmapCache | null;
  /** Test hook; distinct per surface (main pages vs. thumbnails). */
  testId?: string;
  onPageRendered?: (pageNumber: number) => void;
  onPageError?: (pageNumber: number, error: unknown) => void;
}

/** One-shot copy of a finished buffer onto the visible canvas. */
function blit(
  canvas: HTMLCanvasElement,
  buffer: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  // Reassigning width/height reallocates the backing store (and clears it);
  // when the size is unchanged — a cache-hit blit, or a re-render at the
  // same geometry — draw straight into the existing store instead.
  if (canvas.width !== buffer.width) canvas.width = buffer.width;
  if (canvas.height !== buffer.height) canvas.height = buffer.height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.getContext("2d")?.drawImage(buffer, 0, 0);
}

/** Internal control-flow marker: the instance was superseded mid-render. */
class CancelledRender extends Error {
  constructor() {
    super("superseded before blit");
  }
}

/** How many recent render durations the diagnostics attribute retains. */
const RENDER_MS_SAMPLE_COUNT = 5;

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
 *
 * Completed buffers are retained in the shared bitmap cache, so a page that
 * re-enters the virtualization window after eviction blits instantly
 * instead of re-running the full raster — the dominant cost of scrolling
 * back and forth across a heavy (image-laden) page.
 */
export function PdfPageCanvas({
  document,
  pageNumber,
  width,
  height,
  scale,
  preview = false,
  bitmapCache = null,
  testId = "pdf-canvas",
  onPageRendered,
  onPageError,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<PdfRenderTask | null>(null);
  // PERF-2 signal (docs/PERFORMANCE.md): durations (ms) of the last renders
  // published as a deterministic `data-pdf-render-ms` attribute — a
  // diagnostic only, never asserted by timing in CI.
  const renderMsRef = useRef<number[]>([]);

  const publishRenderMs = (canvas: HTMLCanvasElement, ms: number) => {
    const samples = [...renderMsRef.current, ms].slice(-RENDER_MS_SAMPLE_COUNT);
    renderMsRef.current = samples;
    canvas.setAttribute("data-pdf-render-ms", samples.map((value) => value.toFixed(1)).join(";"));
  };

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

    // Fast path: a bitmap rendered at this scale and ratio is already
    // retained from an earlier visit — blit it and report completion. No
    // page request, no raster, no worker round-trip.
    const ratio = effectiveRenderRatio(
      width / scale,
      height / scale,
      scale,
      window.devicePixelRatio || 1,
    );
    const cached = bitmapCache?.get(pageNumber, scale, ratio);
    if (cached) {
      const startedAt = performance.now();
      canvas.setAttribute("data-pdf-render-quality", "final");
      blit(canvas, cached.buffer, width, height);
      publishRenderMs(canvas, performance.now() - startedAt);
      renderedRef.current?.(pageNumber);
      return;
    }

    // Two-stage first paint: the preview tier only exists when refinement
    // would actually change something (ratio > 1); otherwise the render is
    // already final quality and there is nothing to preview.
    const previewRatio = preview ? Math.min(ratio, 1) : ratio;
    const needsRefinement = ratio - previewRatio > 1e-9;

    const renderInto = async (targetRatio: number): Promise<HTMLCanvasElement> => {
      const page = await document.getPage(pageNumber);
      // Checkpoint: this instance may have been superseded while getPage
      // was in flight; do not start work at all.
      if (cancelled) throw new CancelledRender();
      const viewport = page.getViewport({ scale });

      const buffer = canvas.ownerDocument.createElement("canvas");
      buffer.width = Math.floor(viewport.width * targetRatio);
      buffer.height = Math.floor(viewport.height * targetRatio);
      const bufferContext = buffer.getContext("2d");
      if (!bufferContext) throw new Error("Canvas 2D context is unavailable");

      // The transform maps viewport units onto device pixels at the
      // (possibly capped) ratio.
      // Timed from the raster's start (the paint loop is time-sliced across
      // the await) to the blit — the user-visible render→blit latency of
      // PERF-2.
      const startedAt = performance.now();
      const task = page.render({
        canvas: buffer,
        viewport,
        transform: targetRatio !== 1 ? [targetRatio, 0, 0, targetRatio, 0, 0] : undefined,
      });
      taskRef.current = task;
      await task.promise;

      // Checkpoint: only the current generation may touch the canvas.
      if (cancelled) throw new CancelledRender();
      publishRenderMs(canvas, performance.now() - startedAt);
      return buffer;
    };

    (async () => {
      // Stop the previous generation's work early; it renders into its own
      // buffer, so there is no shared state to wait for.
      taskRef.current?.cancel();

      const firstBuffer = await renderInto(previewRatio);
      canvas.setAttribute("data-pdf-render-quality", needsRefinement ? "preview" : "final");
      blit(canvas, firstBuffer, width, height);
      renderedRef.current?.(pageNumber);

      if (!needsRefinement) {
        bitmapCache?.put({ pageNumber, scale, ratio: previewRatio, buffer: firstBuffer });
        return;
      }

      // Background refinement: a fresh buffer at the full effective ratio,
      // atomically replacing the preview blit. The preview is cached too,
      // so a supersession before refinement completes still avoids a
      // re-raster on re-entry.
      bitmapCache?.put({ pageNumber, scale, ratio: previewRatio, buffer: firstBuffer });
      const refinedBuffer = await renderInto(ratio);
      canvas.setAttribute("data-pdf-render-quality", "final");
      bitmapCache?.put({ pageNumber, scale, ratio, buffer: refinedBuffer });
      blit(canvas, refinedBuffer, width, height);
    })().catch((err: unknown) => {
      if (cancelled || isRenderingCancelled(err) || err instanceof CancelledRender) return;
      errorRef.current?.(pageNumber, err);
    });

    return () => {
      cancelled = true;
      taskRef.current?.cancel();
    };
  }, [document, pageNumber, width, height, scale, preview, bitmapCache]);

  return (
    <canvas
      ref={canvasRef}
      data-testid={testId}
      data-pdf-page={pageNumber}
      // PERF-6: no decorations here — the canvas is a page-sized layer and
      // any filter/effect on it is per-frame compositing work. Page chrome
      // lives on the cheap wrapper (PdfDocumentView).
      className="block"
    />
  );
}
