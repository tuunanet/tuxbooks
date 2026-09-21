import { useEffect, useRef } from "react";
import {
  isRenderingCancelled,
  type PdfDocument,
  type PdfRenderTask,
  type SmartPalette,
} from "@/lib/pdf/pdfEngine";
import type { Rect } from "./pdfLayout";
import { effectiveRenderRatio, needsRegionRender, regionRenderRatio } from "./pdfRenderPolicy";
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
   * The visible part of the page, in CSS pixels relative to its top-left.
   * When the whole-page ratio would fall below device resolution
   * (`needsRegionRender`) this canvas rasterizes only the region at full
   * resolution and positions itself inside the page; otherwise the region is
   * ignored and the whole page renders as before.
   */
  region?: Rect;
  /**
   * Two-stage first paint: render a readable preview at ratio ≤ 1, blit it,
   * then refine to the full effective ratio in the background (§ first
   * readable page). Only worth passing while the very first page of a
   * freshly opened document is pending — every later render should just be
   * final quality.
   */
  preview?: boolean;
  /**
   * Smart Dark palette (issue #67): present, the worker recolors text/
   * vector/image-mask colors at raster time; absent, pages render as-is.
   * Part of the render and cache identity — a mode switch re-renders.
   */
  smartColors?: SmartPalette;
  /**
   * The color-mode variant this canvas renders with ("original"|"smart"):
   * keyed into the shared bitmap cache (issue #67), so mode switches never
   * serve the other variant's pixels.
   */
  renderVariant?: string;
  /**
   * Shared per-document bitmap cache (§ rendering policy). A hit blits the
   * retained bitmap synchronously — no engine work; a completed render
   * stores its offscreen buffer so a future re-entry can do the same.
   */
  bitmapCache?: PdfBitmapCache | null;
  /**
   * Whether this canvas may start a new raster. False keeps a canvas that
   * already holds pixels mounted for display only: its previous bitmap is
   * shown scaled to the current geometry while other pages rasterize, and it
   * renders once the reader admits it back into the render budget. The
   * reader uses this for the pages that fall outside `MAX_CONCURRENT_RENDERS`
   * during a zoom commit, so scale-and-swap never queues a page-sized raster
   * for every previously rendered page at once.
   */
  renderEnabled?: boolean;
  /** Test hook; distinct per surface (main pages vs. thumbnails). */
  testId?: string;
  onPageRendered?: (pageNumber: number) => void;
  onPageError?: (pageNumber: number, error: unknown) => void;
}

/**
 * The geometry the last-presented bitmap was rendered at. Scale-and-swap
 * reuses the canvas's own pixels: while the new-scale raster is in flight
 * (or while the canvas is display-only), the previous bitmap is drawn scaled
 * from this box to the current one, so the page never goes blank through a
 * zoom.
 */
interface PresentedGeometry {
  readonly scale: number;
  readonly regionKey: string;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly mode: "full" | "region";
}

/** One-shot copy of a finished buffer onto the visible canvas. */
function blit(
  canvas: HTMLCanvasElement,
  buffer: HTMLCanvasElement,
  width: number,
  height: number,
  left?: number,
  top?: number,
): void {
  // Reassigning width/height reallocates the backing store (and clears it);
  // when the size is unchanged — a cache-hit blit, or a re-render at the
  // same geometry — draw straight into the existing store instead.
  if (canvas.width !== buffer.width) canvas.width = buffer.width;
  if (canvas.height !== buffer.height) canvas.height = buffer.height;
  // Region mode: the offset moves together with the pixels, inside the same
  // atomic paint. React must not own left/top — it re-applies them on every
  // scroll-driven re-render, which would parade the stale bitmap around the
  // page (a ~10% jump) until the new raster lands.
  if (left !== undefined) canvas.style.left = `${left}px`;
  if (top !== undefined) canvas.style.top = `${top}px`;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  // A fresh blit lands at its natural size: clear any scale-and-swap
  // transform left by the previous bitmap so it cannot compound.
  canvas.style.transform = "";
  canvas.style.transformOrigin = "";
  canvas.getContext("2d")?.drawImage(buffer, 0, 0);
}

/**
 * Scale-and-swap: present a bitmap rendered at an earlier scale under a CSS
 * transform sized to the current box. The canvas keeps its previous layout
 * box (the last blit's CSS size) and the transform stretches it to `width` ×
 * `height`, so the old pixels fill the new page rect while the sharp raster
 * runs. Drawing under a transform is exactly Papers' "existing texture drawn
 * scaled into the new rect" (`pps-view-page.c` snapshot).
 */
function presentScaled(
  canvas: HTMLCanvasElement,
  previous: PresentedGeometry,
  width: number,
  height: number,
): void {
  const scaleX = previous.cssWidth > 0 ? width / previous.cssWidth : 1;
  const scaleY = previous.cssHeight > 0 ? height / previous.cssHeight : 1;
  canvas.style.transformOrigin = "top left";
  canvas.style.transform = `scale(${scaleX}, ${scaleY})`;
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
 * Quiet period a superseding change waits out before it starts a raster.
 * PDFium rasterizes synchronously inside its worker and cancellation is only
 * checked between requests, so a heavy render cannot be interrupted mid-way:
 * starting one per intermediate zoom step or scroll-driven region move
 * queues multi-second rasters and reads as a freeze. Only the first render of
 * a canvas instance starts immediately; every later one coalesces, so rapid
 * input settles to a single raster at the final scale/region.
 */
const RENDER_SETTLE_MS = 150;

/**
 * Imperative page renderer: draws one page (or, above the whole-page budget,
 * one viewport region of it) into one canvas at a fixed size.
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
 *
 * Region mode (viewport clipping): when the effective whole-page ratio drops
 * below the display's device pixel ratio (a PERF-1 budget tier binds at high
 * zoom), rasterizing the whole page would be both wasteful and soft — CSS
 * upscales a low-resolution layer. Instead the visible region rasterizes at
 * device resolution into a region-sized canvas that is absolutely positioned
 * inside the page at the region offset, so text stays sharp and the worker
 * never allocates a page-sized buffer at deep zoom. The cache key gains the
 * region, so the whole-page and region bitmaps never collide.
 */
export function PdfPageCanvas({
  document,
  pageNumber,
  width,
  height,
  scale,
  region,
  preview = false,
  smartColors,
  renderVariant = "original",
  bitmapCache = null,
  renderEnabled = true,
  testId = "pdf-canvas",
  onPageRendered,
  onPageError,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<PdfRenderTask | null>(null);
  // The last bitmap presented (blitted or shown scaled). Scale-and-swap
  // reads it to keep the old pixels on screen through a scale change.
  const lastPresentedRef = useRef<PresentedGeometry | null>(null);
  // PERF-2 signal (docs/PERFORMANCE.md): durations (ms) of the last renders
  // published as a deterministic `data-pdf-render-ms` attribute — a
  // diagnostic only, never asserted by timing in CI.
  const renderMsRef = useRef<number[]>([]);
  // Color-mode identity of the last effect run (issue #67 follow-up): a
  // change means the mounted canvas still holds the previous mode's opaque
  // bitmap, which must be cleared before the new-mode render starts.
  const previousVariantRef = useRef(renderVariant);
  // True once this canvas instance has rasterized at least once: the first
  // render starts immediately (open latency), later ones coalesce.
  const renderedOnceRef = useRef(false);

  const dpr = window.devicePixelRatio || 1;
  // Region primitives keep the effect dependencies stable: the parent may
  // hand a fresh object each render, but the effect only re-runs when the
  // numbers (or the mode) actually change.
  const regionMode = region != null && needsRegionRender(width / scale, height / scale, scale, dpr);
  const regionLeft = region?.left ?? 0;
  const regionTop = region?.top ?? 0;
  const regionWidth = region?.width ?? 0;
  const regionHeight = region?.height ?? 0;
  const regionKey = regionMode
    ? `${regionLeft},${regionTop},${regionWidth},${regionHeight}`
    : "full";
  const cssWidth = regionMode ? regionWidth : width;
  const cssHeight = regionMode ? regionHeight : height;
  // Applied imperatively at blit time (never through React's style prop), so
  // a scroll-driven re-render cannot move the stale bitmap before its
  // replacement is ready.
  const blitLeft = regionMode ? regionLeft : undefined;
  const blitTop = regionMode ? regionTop : undefined;

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

    // Mode-switch reset (issue #67 follow-up): a canvas that survives a
    // color-mode change still holds the previous mode's opaque bitmap, and
    // while the new-mode render is in flight it would present the wrong
    // colors entirely (a Smart Dark page sitting dark inside a Default
    // document). Clear it to transparent so the wrapper's themed
    // placeholder shows, exactly like a never-rendered page. Geometry-only
    // re-renders (zoom, resize) deliberately keep the old pixels visible
    // until the atomic blit — smoother there, and the pixels are merely
    // stale-scaled, never wrong-mode.
    if (previousVariantRef.current !== renderVariant) {
      previousVariantRef.current = renderVariant;
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      // Wrong-mode pixels must not be scaled either: drop the swap source.
      lastPresentedRef.current = null;
      canvas.style.transform = "";
      canvas.style.transformOrigin = "";
    }

    const ratio = regionMode
      ? regionRenderRatio(regionWidth, regionHeight, dpr)
      : effectiveRenderRatio(width / scale, height / scale, scale, dpr);

    // Fast path: a bitmap rendered at this scale, ratio, region, and variant
    // is already retained from an earlier visit — blit it and report
    // completion. No page request, no raster, no worker round-trip.
    const cached = bitmapCache?.get(pageNumber, scale, ratio, renderVariant, regionKey);
    if (cached) {
      const startedAt = performance.now();
      canvas.setAttribute("data-pdf-render-quality", "final");
      blit(canvas, cached.buffer, cssWidth, cssHeight, blitLeft, blitTop);
      lastPresentedRef.current = {
        scale,
        regionKey,
        cssWidth,
        cssHeight,
        mode: regionMode ? "region" : "full",
      };
      publishRenderMs(canvas, performance.now() - startedAt);
      renderedRef.current?.(pageNumber);
      return;
    }

    // Scale-and-swap: a canvas that survives a scale change already holds the
    // previous-scale pixels. Present them under a transform sized to the new
    // box immediately, so the visible surface never blanks while the sharp
    // raster runs. Only whole-page rasters are swapped this way; a region
    // canvas is already viewport-sized and keeps its pixels in place.
    const previous = lastPresentedRef.current;
    const swapped =
      previous !== null &&
      previous.mode === "full" &&
      !regionMode &&
      (previous.scale !== scale ||
        previous.regionKey !== regionKey ||
        previous.cssWidth !== cssWidth ||
        previous.cssHeight !== cssHeight);
    if (swapped && previous) {
      presentScaled(canvas, previous, cssWidth, cssHeight);
      canvas.setAttribute("data-pdf-render-quality", "scaled");
    }

    // Display-only stale canvas: keep painting the scaled previous bitmap and
    // let the reader promote this page back into the render budget. Without a
    // previous bitmap there is nothing to show, so stay blank as before.
    if (!renderEnabled) {
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

      // Full mode keeps the engine viewport dimensions for the buffer (the
      // historical behavior); region mode sizes to the region.
      const bufferWidth = regionMode ? regionWidth : viewport.width;
      const bufferHeight = regionMode ? regionHeight : viewport.height;
      const buffer = canvas.ownerDocument.createElement("canvas");
      buffer.width = Math.floor(bufferWidth * targetRatio);
      buffer.height = Math.floor(bufferHeight * targetRatio);
      const bufferContext = buffer.getContext("2d");
      if (!bufferContext) throw new Error("Canvas 2D context is unavailable");

      // The transform maps viewport units onto device pixels at the
      // (possibly capped) ratio. In region mode the engine converts the
      // region to page units and clips the raster to it.
      // Timed from the raster's start (the paint loop is time-sliced across
      // the await) to the blit — the user-visible render→blit latency of
      // PERF-2.
      const startedAt = performance.now();
      const task = page.render({
        canvas: buffer,
        viewport,
        transform: targetRatio !== 1 ? [targetRatio, 0, 0, targetRatio, 0, 0] : undefined,
        smartColors,
        region: regionMode
          ? { x: regionLeft, y: regionTop, width: regionWidth, height: regionHeight }
          : undefined,
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

      // Coalesce superseding changes (see RENDER_SETTLE_MS). The timeout is
      // intentionally not cleared: it is short, and the `cancelled` check
      // after it is what discards a superseded generation.
      if (renderedOnceRef.current) {
        await new Promise<void>((resolve) => setTimeout(resolve, RENDER_SETTLE_MS));
        if (cancelled) throw new CancelledRender();
      }
      renderedOnceRef.current = true;

      const firstBuffer = await renderInto(previewRatio);
      canvas.setAttribute("data-pdf-render-quality", needsRefinement ? "preview" : "final");
      blit(canvas, firstBuffer, cssWidth, cssHeight, blitLeft, blitTop);
      lastPresentedRef.current = {
        scale,
        regionKey,
        cssWidth,
        cssHeight,
        mode: regionMode ? "region" : "full",
      };
      renderedRef.current?.(pageNumber);

      if (!needsRefinement) {
        bitmapCache?.put({
          pageNumber,
          scale,
          ratio: previewRatio,
          variant: renderVariant,
          regionKey,
          buffer: firstBuffer,
        });
        return;
      }

      // Background refinement: a fresh buffer at the full effective ratio,
      // atomically replacing the preview blit. The preview is cached too,
      // so a supersession before refinement completes still avoids a
      // re-raster on re-entry.
      bitmapCache?.put({
        pageNumber,
        scale,
        ratio: previewRatio,
        variant: renderVariant,
        regionKey,
        buffer: firstBuffer,
      });
      const refinedBuffer = await renderInto(ratio);
      canvas.setAttribute("data-pdf-render-quality", "final");
      bitmapCache?.put({
        pageNumber,
        scale,
        ratio,
        variant: renderVariant,
        regionKey,
        buffer: refinedBuffer,
      });
      blit(canvas, refinedBuffer, cssWidth, cssHeight, blitLeft, blitTop);
      lastPresentedRef.current = {
        scale,
        regionKey,
        cssWidth,
        cssHeight,
        mode: regionMode ? "region" : "full",
      };
    })().catch((err: unknown) => {
      if (cancelled || isRenderingCancelled(err) || err instanceof CancelledRender) return;
      errorRef.current?.(pageNumber, err);
    });

    return () => {
      cancelled = true;
      taskRef.current?.cancel();
    };
  }, [
    document,
    pageNumber,
    width,
    height,
    scale,
    preview,
    smartColors,
    renderVariant,
    bitmapCache,
    renderEnabled,
    regionMode,
    regionLeft,
    regionTop,
    regionWidth,
    regionHeight,
    blitLeft,
    blitTop,
    regionKey,
    cssWidth,
    cssHeight,
    dpr,
  ]);

  return (
    <canvas
      ref={canvasRef}
      data-testid={testId}
      data-pdf-page={pageNumber}
      // Deterministic region identity for tests/diagnostics: "full" for a
      // whole-page raster, else the page-local `x,y,w,h` of the region.
      data-pdf-render-region={regionKey}
      style={regionMode ? { position: "absolute" } : undefined}
      // PERF-6: no decorations here — the canvas is a page-sized layer and
      // any filter/effect on it is per-frame compositing work. Page chrome
      // lives on the cheap wrapper (PdfDocumentView).
      className="block"
    />
  );
}
