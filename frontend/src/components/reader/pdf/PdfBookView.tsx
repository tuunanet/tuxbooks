import { useCallback, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import type { PdfDocument, SmartPalette } from "@/lib/pdf/pdfEngine";
import { PdfPageCanvas } from "./PdfPageCanvas";
import type { PdfBitmapCache } from "./pdfBitmapCache";
import {
  PAPERS_VIEW_SPACING,
  displayedSizes,
  fitPageScale,
  layoutSpread,
  type PageSize,
} from "./pdfLayout";

interface PdfBookViewProps {
  /** The open document handle — shared with the scroll view (one worker). */
  document: PdfDocument;
  /** Page sizes in page units (points) at scale 1, from the shared geometry. */
  sizes: PageSize[];
  /** The 1-based page the reading position names; its spread renders. */
  currentPage: number;
  /**
   * The shared per-document bitmap cache instance: spread pages raster
   * through the same budgeted canvas pipeline as the scroll view and store
   * into the same cache, so toggling between the views blits instead of
   * re-rasterizing.
   */
  bitmapCache?: PdfBitmapCache | null;
  /** Measured content width — the fit-the-pair horizontal input. */
  areaWidth: number;
  /** Measured scroll-viewport height — the fit-the-pair vertical input. */
  viewportHeight: number;
  /** Registers the book surface as the measured content area (usePdfScale). */
  contentAreaRef?: Ref<HTMLDivElement>;
  /** Smart Dark palette (issue #67); same render identity as the scroll view. */
  smartColors?: SmartPalette;
  /** Color-mode variant keyed into the shared bitmap cache. */
  renderVariant?: string;
  /**
   * CSS background for a page wrapper while its raster is pending, so a
   * Smart Dark page does not flash white before its bitmap blits.
   */
  pageBackground?: string;
}

const NO_PAGES: ReadonlySet<number> = new Set();

/**
 * The book-mode reading surface (tuxbooks-9pr): the spread containing the
 * current page, painted through the existing raster path. It is a separate
 * view mounted in place of the continuous document while book mode is on —
 * never a mode inside the scroll view's virtualization — and it shares the
 * open document handle (and with it the render worker), the bitmap cache,
 * and the theme render identity with that view, so toggling modes never
 * re-loads or re-rasters the document.
 *
 * Geometry: `layoutSpread` (the single home of the "page 1 alone, then
 * facing pairs" rule) groups the pages; the spread is fit to the measured
 * viewport on both axes (`fitPageScale` over the spread bounds — the same
 * containment formula presentation mode applies to one page). Book mode is
 * fit-the-pair only; there is no zoom state here.
 *
 * Budget: at most two `PdfPageCanvas` surfaces are ever mounted (one per
 * spread page), each rasterized at the capped effective ratio and cached
 * through the shared `pdfBitmapCache` — a spread cannot exceed the scroll
 * view's per-page budgets because it *is* two scroll-view pages.
 */
export function PdfBookView({
  document,
  sizes,
  currentPage,
  bitmapCache = null,
  areaWidth,
  viewportHeight,
  contentAreaRef,
  smartColors,
  renderVariant = "original",
  pageBackground,
}: PdfBookViewProps) {
  const pageIndex = Math.max(0, currentPage - 1);
  // The spread in page units — only its bounds feed the fit. The inter-page
  // gap rides at PAGE_GAP_PX in both this call and the displayed one below;
  // the Papers margin (2 * PAPERS_VIEW_SPACING) reserved by the fit absorbs
  // the few unscaled gap pixels, so the displayed spread always fits.
  const rawSpread = useMemo(() => layoutSpread(sizes, pageIndex), [sizes, pageIndex]);
  const scale = useMemo(
    () =>
      rawSpread
        ? fitPageScale(
            areaWidth,
            viewportHeight,
            rawSpread.bounds.width,
            rawSpread.bounds.height,
            PAPERS_VIEW_SPACING,
          )
        : 1,
    [rawSpread, areaWidth, viewportHeight],
  );
  // The painted spread: the same geometry function, now over displayed
  // sizes, so page rects stay layoutSpread's output — book mode never
  // computes page rectangles inline.
  const spread = useMemo(
    () => layoutSpread(displayedSizes(sizes, scale), pageIndex),
    [sizes, scale, pageIndex],
  );

  // Pages of the current spread that have painted (blit or raster). Keyed
  // by the spread so a turn starts from an honest empty set — diagnostics
  // and tests only, never render-critical.
  const spreadKey = spread ? `${pageIndex}@${scale}` : "none";
  const [paintState, setPaintState] = useState<{ key: string; pages: ReadonlySet<number> }>(() => ({
    key: spreadKey,
    pages: new Set(),
  }));
  if (paintState.key !== spreadKey) {
    setPaintState({ key: spreadKey, pages: new Set() });
  }
  const painted = paintState.key === spreadKey ? paintState.pages : NO_PAGES;
  // The canvas reports through a ref it refreshes per render, so a report
  // can land through a callback from the previous commit — read the live
  // key from a ref (refreshed in a layout effect, before any raster of
  // that commit can report) instead of closing over it.
  const spreadKeyRef = useRef(spreadKey);
  useLayoutEffect(() => {
    spreadKeyRef.current = spreadKey;
  }, [spreadKey]);
  const handlePageRendered = useCallback((pageNumber: number) => {
    const key = spreadKeyRef.current;
    setPaintState((current) =>
      current.key !== key || current.pages.has(pageNumber)
        ? current
        : { key: current.key, pages: new Set(current.pages).add(pageNumber) },
    );
  }, []);

  if (!spread) return null;

  return (
    <div ref={contentAreaRef} data-testid="pdf-content-area" className="flex min-h-0 w-full">
      <div
        data-testid="pdf-book-view"
        data-pdf-book-rendered={[...painted].sort((a, b) => a - b).join(",")}
        className="relative mx-auto"
        style={{ width: `${spread.bounds.width}px`, height: `${spread.bounds.height}px` }}
      >
        {spread.pages.map((page) => (
          // Page chrome on the cheap wrapper, never on the canvas layer
          // (PERF-6) — same split as the scroll view's page slots.
          <div
            key={page.pageNumber}
            data-pdf-book-page={page.pageNumber}
            className="absolute overflow-hidden rounded-sm border bg-white"
            style={{
              left: `${page.left}px`,
              top: `${page.top}px`,
              width: `${page.width}px`,
              height: `${page.height}px`,
              ...(pageBackground ? { backgroundColor: pageBackground } : {}),
            }}
          >
            <PdfPageCanvas
              document={document}
              pageNumber={page.pageNumber}
              width={page.width}
              height={page.height}
              scale={scale}
              smartColors={smartColors}
              renderVariant={renderVariant}
              bitmapCache={bitmapCache}
              testId="pdf-book-canvas"
              onPageRendered={handlePageRendered}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
