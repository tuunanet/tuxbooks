import { renderPdfPageBitmap } from "./pdfPageBitmap";
import type { PdfBitmapCache } from "./pdfBitmapCache";
import { isRenderingCancelled, type PdfDocument, type SmartPalette } from "@/lib/pdf/pdfEngine";

/** One pre-renderable neighbour page: the cache key its canvas looks up. */
export interface PdfPreloadTarget {
  pageNumber: number;
  scale: number;
  ratio: number;
}

interface PdfPreloadQueueParams {
  document: PdfDocument;
  /** Reading direction first: the queue rasters one target at a time. */
  targets: PdfPreloadTarget[];
  bitmapCache: PdfBitmapCache;
  renderVariant: string;
  smartColors?: SmartPalette;
  /** Called after a target bitmap lands in the cache (diagnostics). */
  onPreloaded?: (pageNumber: number) => void;
}

/**
 * Rasters the queued neighbour bitmaps into the shared cache — one at a
 * time, failures silent — so navigation blits a finished bitmap instead
 * of paying the raster. Shared by the presentation and book preloads
 * (tuxbooks-9pr review), whose target derivations differ but whose run
 * is identical: a superseded run stops before its next target and
 * cancels the in-flight raster; a miss stays silent because live
 * rendering still covers it. The returned function cancels the run.
 */
export function startPdfPreloadQueue(params: PdfPreloadQueueParams): () => void {
  const { document, targets, bitmapCache, renderVariant, smartColors, onPreloaded } = params;
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
      } finally {
        active = null;
      }
    }
  })();

  return () => {
    cancelled = true;
    active?.cancel();
  };
}
