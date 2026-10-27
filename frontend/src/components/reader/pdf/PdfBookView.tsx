import { useCallback, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import type { Annotation } from "@/types/domain";
import type { HighlightOverrides, HighlightThemeFamily } from "@/lib/highlightPalette";
import type { PdfDocument, SmartPalette } from "@/lib/pdf/pdfEngine";
import { useReader } from "@/state/readerState";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { PdfHighlightOverlay } from "./PdfHighlightOverlay";
import { PdfPageCanvas } from "./PdfPageCanvas";
import { PdfPageTextLayer } from "./PdfPageTextLayer";
import type { PdfBitmapCache } from "./pdfBitmapCache";
import { createInstantPdfBookTurn, type PdfBookTurnAdapter } from "./pdfBookTurn";
import {
  PAPERS_VIEW_SPACING,
  displayedSizes,
  fitPageScale,
  layoutSpread,
  type PageSize,
} from "./pdfLayout";
import { pageToPosition } from "./pdfPages";

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
  /** Persisted highlights by page number; drawn over the spread pages. */
  highlightsByPage?: Map<number, Annotation[]>;
  /** Theme family of the active reader theme; picks highlight washes + blend. */
  highlightFamily: HighlightThemeFamily;
  /** Per-family highlight hue overrides (lib/highlightPalette). */
  highlightOverrides: HighlightOverrides;
  /** CSS filter implementing the reader theme over the spread
   *  (undefined = pages as-is); see lib/pdf/theme.ts. */
  themeFilter?: string;
  /** Multiply-tint color for paper-style themes (white pages take on the
   *  tint); undefined = no overlay. See lib/pdf/theme.ts. */
  themeTint?: string;
  /**
   * Injected turn adapter (the component-test seam; tuxbooks-9pr.5). When
   * provided it replaces the Stage 1 instant adapter this view would
   * otherwise create from the reading position.
   */
  turnAdapter?: PdfBookTurnAdapter | null;
  /**
   * Filled with the active turn adapter (injected or created here) so the
   * shell's keyboard routes through the same instance the edge/corner
   * zones call; nulled on unmount.
   */
  bookTurnRef?: { current: PdfBookTurnAdapter | null };
}

const NO_PAGES: ReadonlySet<number> = new Set();

/** How far the edge turn strips reach in from each page's outer edge. */
const TURN_EDGE_WIDTH_PX = 32;
/** Leg length of the triangular bottom-corner turn zones. */
const TURN_CORNER_SIZE_PX = 72;

const TURN_LABELS = {
  prev: "Turn to the previous spread",
  next: "Turn to the next spread",
} as const;

type TurnDirection = keyof typeof TURN_LABELS;

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
  highlightsByPage,
  highlightFamily,
  highlightOverrides,
  themeFilter,
  themeTint,
  turnAdapter = null,
  bookTurnRef,
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

  // Turn adapter (tuxbooks-9pr.5): the book view reads the reduced-motion
  // media query itself (the adapter must not) and passes the flag into the
  // Stage 1 instant adapter, whose settle moves the reading position — the
  // spread the position names is what renders, so the position model stays
  // the single source of truth. An injected adapter (the test seam) wins
  // over the created one; either way the active instance registers into
  // bookTurnRef so the shell's keyboard steps through this same path.
  const { setPosition } = useReader();
  const reducedMotion = usePrefersReducedMotion();
  const onSettle = useCallback(
    (pageNumber: number) => setPosition(pageToPosition(pageNumber, sizes.length)),
    [setPosition, sizes.length],
  );
  const createdTurn = useMemo(
    () =>
      createInstantPdfBookTurn({ currentPage, pageCount: sizes.length, reducedMotion, onSettle }),
    [currentPage, sizes.length, reducedMotion, onSettle],
  );
  const turn = turnAdapter ?? createdTurn;
  useLayoutEffect(() => {
    if (!bookTurnRef) return;
    bookTurnRef.current = turn;
    return () => {
      bookTurnRef.current = null;
    };
  }, [bookTurnRef, turn]);

  if (!spread) return null;

  // Turn affordances (spec → Turn interaction): an edge strip along each
  // spread-edge page's outer edge plus a triangular bottom-corner zone per
  // direction. They are chrome buttons layered over the page wrappers —
  // never over the canvas layer (PERF-6) — and cover only the edges, so
  // interior clicks stay untouched. The hover shade rides the foreground
  // token, subtle on light or Smart Dark pages alike.
  const turnStrip = (direction: TurnDirection, side: "left" | "right") => (
    <button
      type="button"
      data-pdf-book-turn-edge={direction}
      aria-label={TURN_LABELS[direction]}
      className={`absolute inset-y-0 cursor-pointer hover:bg-foreground/10 ${side === "left" ? "left-0" : "right-0"}`}
      style={{ width: `${TURN_EDGE_WIDTH_PX}px` }}
      onClick={direction === "prev" ? turn.retreat : turn.advance}
    />
  );
  const turnCorner = (direction: TurnDirection) => (
    <button
      type="button"
      data-pdf-book-turn-corner={direction}
      aria-label={TURN_LABELS[direction]}
      className={`absolute bottom-0 cursor-pointer hover:bg-foreground/10 ${
        direction === "prev" ? "left-0" : "right-0"
      }`}
      style={{
        width: `${TURN_CORNER_SIZE_PX}px`,
        height: `${TURN_CORNER_SIZE_PX}px`,
        clipPath:
          direction === "prev"
            ? "polygon(0 0, 0 100%, 100% 100%)"
            : "polygon(100% 0, 100% 100%, 0 100%)",
      }}
      onClick={direction === "prev" ? turn.retreat : turn.advance}
    />
  );

  return (
    <div ref={contentAreaRef} data-testid="pdf-content-area" className="flex min-h-0 w-full">
      <div
        data-testid="pdf-book-view"
        data-pdf-book-rendered={[...painted].sort((a, b) => a - b).join(",")}
        data-pdf-book-reduced-motion={reducedMotion}
        className="relative mx-auto"
        style={{
          width: `${spread.bounds.width}px`,
          height: `${spread.bounds.height}px`,
          filter: themeFilter,
        }}
      >
        {/* Paper-style themes multiply-tint the opaque white pages down
            to the theme color (white × tint = tint, black stays black).
            The overlay covers the whole spread and ignores the pointer. */}
        {themeTint && (
          <div
            aria-hidden
            data-testid="pdf-theme-tint"
            className="pointer-events-none absolute inset-0 z-10"
            style={{ backgroundColor: themeTint, mixBlendMode: "multiply" }}
          />
        )}
        {spread.pages.map((page, index) => (
          // Page chrome on the cheap wrapper, never on the canvas layer
          // (PERF-6) — same split as the scroll view's page slots. The
          // scroll view's slot attribute rides along so the reader's
          // settled-selection pipeline resolves book pages exactly like
          // scroll slots (selection/highlight parity, tuxbooks-9pr.6).
          <div
            key={page.pageNumber}
            data-pdf-book-page={page.pageNumber}
            data-pdf-slot={page.pageNumber}
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
            {/* The selectable text surface, at the spread's fit scale —
                same gate as the scroll view: a text layer only on pages
                whose canvas has painted. */}
            {painted.has(page.pageNumber) && (
              <PdfPageTextLayer document={document} pageNumber={page.pageNumber} scale={scale} />
            )}
            {/* Persisted highlights, one overlay per spread page — the
                same normalized page space the scroll view draws in, so
                they track the canvas at the spread scale. */}
            <PdfHighlightOverlay
              highlights={highlightsByPage?.get(page.pageNumber) ?? []}
              family={highlightFamily}
              overrides={highlightOverrides}
            />
            {/* The spread's outer edges turn; the gutter-side edge of a
                paired page does not. The lone cover is both edges. */}
            {index === 0 && turnStrip("prev", "left")}
            {index === spread.pages.length - 1 && turnStrip("next", "right")}
          </div>
        ))}
        {turnCorner("prev")}
        {turnCorner("next")}
      </div>
    </div>
  );
}
