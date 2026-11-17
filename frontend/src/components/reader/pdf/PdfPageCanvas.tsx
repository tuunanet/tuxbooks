import { useEffect, useLayoutEffect, useRef } from "react";
import { type PdfDocument, type SmartPalette } from "@/lib/pdf/pdfEngine";
import type { Rect } from "./pdfLayout";
import {
  effectiveRenderRatio,
  needsRegionRender,
  regionRenderRatioForPage,
} from "./pdfRenderPolicy";
import type { PdfBitmapCache } from "./pdfBitmapCache";
import {
  blitFromCache,
  presentPrevious,
  RENDER_MS_SAMPLE_COUNT,
  runRenderCommitment,
  type PresentedGeometry,
  type RegionTarget,
  type RenderGeneration,
  type RenderPipeline,
} from "./pdfRenderPipeline";

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
  const activeRef = useRef<RenderGeneration | null>(null);
  // The render effect has no cleanup (a same-inputs re-run must not kill the commitment); unmount kills.
  useEffect(
    () => () => {
      const active = activeRef.current;
      if (active) {
        active.cancelled = true;
        active.task?.cancel();
      }
    },
    [],
  );
  const lastPresentedRef = useRef<PresentedGeometry | null>(null);
  const renderMsRef = useRef<number[]>([]);
  const previousVariantRef = useRef(renderVariant);
  const renderedOnceRef = useRef(false);
  const scaleRef = useRef(scale);

  const dpr = window.devicePixelRatio || 1;
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
  // Placement is imperative so a scroll-driven re-run cannot move the stale bitmap early.
  const blitLeft = regionMode ? regionLeft : undefined;
  const blitTop = regionMode ? regionTop : undefined;
  const regionRef = useRef<RegionTarget>({
    regionKey,
    regionLeft,
    regionTop,
    regionWidth,
    regionHeight,
    cssWidth,
    cssHeight,
    blitLeft,
    blitTop,
  });

  const publishRenderMs = (canvas: HTMLCanvasElement, ms: number) => {
    const samples = [...renderMsRef.current, ms].slice(-RENDER_MS_SAMPLE_COUNT);
    renderMsRef.current = samples;
    canvas.setAttribute("data-pdf-render-ms", samples.map((value) => value.toFixed(1)).join(";"));
  };

  const renderedRef = useRef(onPageRendered);
  useLayoutEffect(() => {
    renderedRef.current = onPageRendered;
  });
  const errorRef = useRef(onPageError);
  useLayoutEffect(() => {
    errorRef.current = onPageError;
  });

  // Layout phase, not passive: as a passive effect this flashed the placeholder for a frame.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Inputs identity excludes the render budget and region moves on purpose: superseding on either kept slots white through scroll (tuxbooks-x27.2).
    regionRef.current = {
      regionKey,
      regionLeft,
      regionTop,
      regionWidth,
      regionHeight,
      cssWidth,
      cssHeight,
      blitLeft,
      blitTop,
    };
    const inputsKey =
      `${pageNumber}:${width}x${height}@${scale}/` +
      `${renderVariant}/${preview}/${dpr}/` +
      `${smartColors ? JSON.stringify(smartColors) : ""}`;

    const active = activeRef.current;
    if (
      active &&
      active.document === document &&
      active.key === inputsKey &&
      !active.cancelled &&
      active.status === "live"
    ) {
      return;
    }
    if (active) {
      active.cancelled = true;
      if (active.status === "live") active.task?.cancel();
    }
    const gen: RenderGeneration = {
      document,
      key: inputsKey,
      status: "pending",
      cancelled: false,
      task: null,
    };
    activeRef.current = gen;

    const ratio = regionMode
      ? regionRenderRatioForPage(
          width / scale,
          height / scale,
          regionWidth,
          regionHeight,
          scale,
          dpr,
        )
      : effectiveRenderRatio(width / scale, height / scale, scale, dpr);
    const pipeline: RenderPipeline = {
      canvas,
      document,
      pageNumber,
      width,
      height,
      scale,
      preview,
      smartColors,
      renderVariant,
      bitmapCache,
      dpr,
      regionMode,
      fullRatio: ratio,
      gen,
      regionRef,
      scaleRef,
      renderedOnceRef,
      lastPresentedRef,
      renderedRef,
      errorRef,
      publishRenderMs: (ms) => publishRenderMs(canvas, ms),
    };

    // A color-mode switch must clear the previous mode's opaque bitmap before the new render.
    if (previousVariantRef.current !== renderVariant) {
      previousVariantRef.current = renderVariant;
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      lastPresentedRef.current = null;
      canvas.style.transform = "";
      canvas.style.transformOrigin = "";
    }

    if (blitFromCache(pipeline, ratio)) return;

    presentPrevious(pipeline);

    if (!renderEnabled) {
      return;
    }

    void runRenderCommitment(pipeline);
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
      data-pdf-render-region={regionKey}
      style={regionMode ? { position: "absolute" } : undefined}
      // PERF-6: no filters/effects on the canvas; page chrome lives on the cheap wrapper.
      className="block"
    />
  );
}
