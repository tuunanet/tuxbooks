import { useEffect } from "react";
import {
  computePdfScale,
  PAPERS_VIEW_SPACING,
  type PageSize,
  type PdfScaleRequest,
} from "../pdfLayout";
import { presentationPagePlan } from "../pdfRenderPolicy";
import { renderPdfPageBitmap } from "../pdfPageBitmap";
import type { PdfBitmapCache } from "../pdfBitmapCache";
import { isRenderingCancelled, type PdfDocument, type SmartPalette } from "@/lib/pdf/pdfEngine";

/** The zoom request without the per-page presentation override. */
export type PdfPreloadRequest = Omit<PdfScaleRequest, "presentationPage">;

interface PdfPresentationPreloadParams {
  document: PdfDocument | null;
  sizes: PageSize[] | null;
  currentPage: number;
  pageCount: number;
  /** Only preload while presentation mode is active. */
  enabled: boolean;
  /** Zoom state every neighbour's own fit scale is computed from. */
  request: PdfPreloadRequest;
  /** The current page is on screen; nothing should compete with its raster. */
  currentPageReady: boolean;
  /** Whether a neighbour's real size is known (gates on measurement). */
  isMeasured: (pageNumber: number) => boolean;
  areaWidth: number;
  viewportHeight: number;
  bitmapCache: PdfBitmapCache;
  smartColors?: SmartPalette;
  renderVariant: string;
  dpr: number;
  /** Called after a neighbour bitmap lands in the cache (diagnostics). */
  onPreloaded?: (pageNumber: number) => void;
}

/**
 * Pre-render the presentation neighbours into the shared bitmap cache.
 *
 * Presentation lays out a single page, so the virtualization observers never
 * see a neighbour and the render budget never admits one: the page you
 * navigate to used to raster from scratch behind a blank placeholder.
 * Pre-rendering it here mirrors Papers, which keeps a `next_job`/`prev_job`
 * texture at high/low priority behind the current one (`pps-view-
 * presentation.c`, `pps_view_presentation_update_current_page`), so a step
 * blits a finished bitmap instead of paying the raster. Reading direction is
 * priority: next first, then previous, one raster at a time. A superseded run
 * is cancelled; a failed preload is silent and navigation falls back to the
 * canvas's own live render.
 */
export function usePdfPresentationPreload(params: PdfPresentationPreloadParams): void {
  const {
    document,
    sizes,
    currentPage,
    pageCount,
    enabled,
    request,
    currentPageReady,
    isMeasured,
    areaWidth,
    viewportHeight,
    bitmapCache,
    smartColors,
    renderVariant,
    dpr,
    onPreloaded,
  } = params;

  useEffect(() => {
    if (!enabled || !document || !sizes || !currentPageReady) return;
    if (areaWidth <= 0 || viewportHeight <= 0) return;

    const targets: { pageNumber: number; scale: number; ratio: number }[] = [];
    // Next is the reading direction, previous is the safety net: Papers gives
    // the forward neighbour HIGH priority and the backward one LOW, and only
    // one of them is ever mid-raster.
    for (const pageNumber of [currentPage + 1, currentPage - 1]) {
      if (pageNumber < 1 || pageNumber > pageCount) continue;
      if (!isMeasured(pageNumber)) continue;
      const size = sizes[pageNumber - 1];
      if (!size) continue;
      const scale = computePdfScale(
        { ...request, presentationPage: size },
        areaWidth,
        viewportHeight,
        PAPERS_VIEW_SPACING,
      );
      const { ratio } = presentationPagePlan(size, scale, dpr);
      if (bitmapCache.get(pageNumber, scale, ratio, renderVariant, "full")) continue;
      targets.push({ pageNumber, scale, ratio });
    }
    if (targets.length === 0) return;

    let cancelled = false;
    let active: { cancel(): void } | null = null;

    void (async () => {
      for (const target of targets) {
        if (cancelled) return;
        const render = renderPdfPageBitmap({
          document,
          pageNumber: target.pageNumber,
          scale: target.scale,
          ratio: target.ratio,
          smartColors,
        });
        active = render;
        try {
          const buffer = await render.promise;
          if (cancelled) return;
          bitmapCache.put({
            pageNumber: target.pageNumber,
            scale: target.scale,
            ratio: target.ratio,
            variant: renderVariant,
            regionKey: "full",
            buffer,
          });
          onPreloaded?.(target.pageNumber);
        } catch (error) {
          if (isRenderingCancelled(error)) return;
          // Swallow: navigation still renders live if the preload missed.
        } finally {
          active = null;
        }
      }
    })();

    return () => {
      cancelled = true;
      active?.cancel();
    };
  }, [
    enabled,
    document,
    sizes,
    currentPage,
    pageCount,
    currentPageReady,
    isMeasured,
    areaWidth,
    viewportHeight,
    bitmapCache,
    smartColors,
    renderVariant,
    dpr,
    request,
    onPreloaded,
  ]);
}
