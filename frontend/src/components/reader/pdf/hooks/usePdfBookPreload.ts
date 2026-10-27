import { useEffect } from "react";
import {
  PAPERS_VIEW_SPACING,
  fitPageScale,
  layoutSpread,
  nextSpreadPageIndex,
  previousSpreadPageIndex,
  spreadStartIndex,
  type PageSize,
} from "../pdfLayout";
import { presentationPagePlan } from "../pdfRenderPolicy";
import { renderPdfPageBitmap } from "../pdfPageBitmap";
import type { PdfBitmapCache } from "../pdfBitmapCache";
import { isRenderingCancelled, type PdfDocument, type SmartPalette } from "@/lib/pdf/pdfEngine";

interface PdfBookPreloadParams {
  document: PdfDocument | null;
  /** Page sizes in page units, from the shared geometry. */
  sizes: PageSize[] | null;
  /** The 1-based page the reading position names; its spread is current. */
  currentPage: number;
  pageCount: number;
  /** Only preload while book mode is the active surface. */
  enabled: boolean;
  /** Measured content width — the fit-the-pair horizontal input. */
  areaWidth: number;
  /** Measured viewport height — the fit-the-pair vertical input. */
  viewportHeight: number;
  /** Whether a neighbour page's real size is known (gates on measurement). */
  isMeasured: (pageNumber: number) => boolean;
  bitmapCache: PdfBitmapCache;
  smartColors?: SmartPalette;
  renderVariant: string;
  dpr: number;
  /** Called after a neighbour bitmap lands in the cache (diagnostics). */
  onPreloaded?: (pageNumber: number) => void;
}

/**
 * Pre-render the book mode neighbours — the next and previous spreads —
 * into the shared bitmap cache, mirroring the presentation-mode preload
 * (issue #65 / Papers' `next_job`/`prev_job`): reading direction first,
 * then the safety net, one raster at a time, failures silent. The crux
 * that makes the presentation hook's scale derivation wrong here: a book
 * spread is fit as a *pair* (`fitPageScale` over the spread bounds, the
 * same formula `PdfBookView` paints at), not per page, so a bitmap keyed
 * at any other scale misses the canvas's lookup on arrival and the turn
 * pays a fresh raster. This hook computes each neighbour spread's own
 * fit-the-pair scale and stores under exactly the key its pages' canvases
 * will look up, so a turn blits a finished bitmap instead of showing a
 * blank page.
 */
export function usePdfBookPreload(params: PdfBookPreloadParams): void {
  const {
    document,
    sizes,
    currentPage,
    pageCount,
    enabled,
    areaWidth,
    viewportHeight,
    isMeasured,
    bitmapCache,
    smartColors,
    renderVariant,
    dpr,
    onPreloaded,
  } = params;

  useEffect(() => {
    if (!enabled || !document || !sizes) return;
    if (areaWidth <= 0 || viewportHeight <= 0) return;

    const pageIndex = Math.max(0, currentPage - 1);
    const currentStart = spreadStartIndex(pageIndex);
    const targets: { pageNumber: number; scale: number; ratio: number }[] = [];
    // Next spread is the reading direction, previous is the safety net —
    // same priority order as the presentation preload, one raster at a
    // time. A turn clamped at the document end names a page of the
    // current spread itself; that is no neighbour and is skipped.
    for (const neighbourIndex of [
      nextSpreadPageIndex(pageIndex, pageCount),
      previousSpreadPageIndex(pageIndex),
    ]) {
      if (spreadStartIndex(neighbourIndex) === currentStart) continue;
      const spread = layoutSpread(sizes, neighbourIndex);
      if (!spread) continue;
      // The neighbour spread's own fit-the-pair scale — the one its
      // canvases will paint and cache-key at, never the per-page fit.
      const scale = fitPageScale(
        areaWidth,
        viewportHeight,
        spread.bounds.width,
        spread.bounds.height,
        PAPERS_VIEW_SPACING,
      );
      for (const page of spread.pages) {
        if (!isMeasured(page.pageNumber)) continue;
        const size = sizes[page.pageNumber - 1];
        if (!size) continue;
        const { ratio } = presentationPagePlan(size, scale, dpr);
        if (bitmapCache.get(page.pageNumber, scale, ratio, renderVariant, "full")) continue;
        targets.push({ pageNumber: page.pageNumber, scale, ratio });
      }
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
          // Swallow: the turn still renders live if the preload missed.
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
    areaWidth,
    viewportHeight,
    isMeasured,
    bitmapCache,
    smartColors,
    renderVariant,
    dpr,
    onPreloaded,
  ]);
}
