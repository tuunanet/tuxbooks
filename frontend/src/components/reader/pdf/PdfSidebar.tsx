import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PdfDocument } from "@/lib/pdf/pdfEngine";
import { PdfPageCanvas } from "./PdfPageCanvas";
import { usePdfVirtualization } from "./hooks/usePdfVirtualization";
import { thumbnailGeometry, type PageSize } from "./pdfLayout";

/** Displayed thumbnail width in CSS pixels; height follows the page aspect. */
export const THUMBNAIL_WIDTH_PX = 112;

/**
 * Upper bound on simultaneously mounted thumbnail canvases (the sidebar's
 * render budget). Visible thumbnails at this width number well under half
 * of it; the bound is the regression guard against rendering the whole
 * document as bitmaps.
 */
export const MAX_THUMBNAIL_CANVASES = 12;

interface PdfSidebarProps {
  document: PdfDocument;
  /** Page-unit sizes (measured or estimated); drives cell aspects. */
  sizes: PageSize[];
  /** The reading position's page; its thumbnail is highlighted and in view. */
  currentPage: number;
  /** Measures approaching pages so mixed-size thumbnails correct lazily. */
  measurePages: (pageNumbers: number[]) => void;
  /** Navigates the reader to a clicked thumbnail's page. */
  onNavigate: (pageNumber: number) => void;
}

/**
 * The PDF thumbnails sidebar: one lightweight cell per page with canvases
 * only for the bounded render set, following the same policy as the main
 * document surface — one render at a time, visible thumbnails first, a
 * completed canvas stays mounted only while its cell remains in the
 * virtualization window, so memory stays bounded no matter how long the
 * document is. The highlight follows the reading position (scroll tracking
 * and navigation alike), and clicking a cell navigates the reader.
 */
export function PdfSidebar({
  document,
  sizes,
  currentPage,
  measurePages,
  onNavigate,
}: PdfSidebarProps) {
  const { registerSlot, visiblePages, preloadPages } = usePdfVirtualization();
  const [renderedThumbs, setRenderedThumbs] = useState<ReadonlySet<number>>(() => new Set());
  // Thumbnail failures are recorded with the render window they failed in;
  // once the window moves, the failure is stale and the cell re-attempts on
  // re-entry — derived at selection time, no lifecycle state to reconcile.
  const [failedThumbs, setFailedThumbs] = useState<ReadonlyMap<number, string>>(() => new Map());
  const cellElementsRef = useRef(new Map<number, HTMLDivElement>());
  // A click already brings its thumbnail into view; the following page
  // change must not re-scroll (and scroll-tracking must not fight it).
  const suppressAutoScrollRef = useRef(false);

  // Render candidates, anchor-first: the first visible cell (or the reading
  // page before the first observer report) leads, then everything visible
  // and preloading, nearest first, capped at the sidebar's render budget.
  const renderOrder = useMemo(() => {
    const visibleList = [...visiblePages].sort((a, b) => a - b);
    const anchor = visibleList[0] ?? currentPage;
    const candidates = [...new Set([anchor, ...visibleList, ...preloadPages])].sort(
      (a, b) => Math.abs(a - anchor) - Math.abs(b - anchor),
    );
    return candidates.slice(0, MAX_THUMBNAIL_CANVASES);
  }, [visiblePages, preloadPages, currentPage]);

  // Stable key of the current render window; failure staleness is judged
  // against it.
  const windowKey = useMemo(() => renderOrder.join(","), [renderOrder]);

  // Exactly one render in flight: completed canvases stay mounted within the
  // window and a single next page joins them (worker rasterization is
  // serial — queueing more would only starve the cell the user looks at).
  // A failure only blocks its page while it still belongs to this window.
  const canvasPages = useMemo(() => {
    const completed = [...renderedThumbs].filter((page) => renderOrder.includes(page));
    const next = renderOrder.find(
      (page) => !renderedThumbs.has(page) && failedThumbs.get(page) !== windowKey,
    );
    return next === undefined ? completed : [...completed, next];
  }, [renderOrder, renderedThumbs, failedThumbs, windowKey]);

  const failedInWindow = useCallback(
    (pageNumber: number) => failedThumbs.get(pageNumber) === windowKey,
    [failedThumbs, windowKey],
  );

  // Measure approaching cells so mixed-size documents correct their
  // estimates before their thumbnails render (same lazy geometry policy as
  // the document surface; already-measured pages are skipped inside the hook).
  useEffect(() => {
    if (visiblePages.size === 0 && preloadPages.size === 0) return;
    measurePages([...visiblePages, ...preloadPages]);
  }, [measurePages, visiblePages, preloadPages]);

  // Follow the reading position: whenever the page changed from outside the
  // sidebar (scroll tracking, navigation, restore, open), bring the current
  // cell into view without jumping it to an edge.
  useEffect(() => {
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false;
      return;
    }
    cellElementsRef.current.get(currentPage)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [currentPage]);

  const registerCell = useCallback(
    (pageNumber: number, element: HTMLDivElement | null) => {
      if (element) {
        cellElementsRef.current.set(pageNumber, element);
      } else {
        cellElementsRef.current.delete(pageNumber);
      }
      registerSlot(pageNumber, element);
    },
    [registerSlot],
  );

  const handleThumbRendered = useCallback((pageNumber: number) => {
    setRenderedThumbs((current) => {
      if (current.has(pageNumber)) return current;
      const next = new Set(current);
      next.add(pageNumber);
      return next;
    });
  }, []);

  const handleThumbError = useCallback(
    (pageNumber: number, renderError: unknown) => {
      setFailedThumbs((current) => {
        if (current.get(pageNumber) === windowKey) return current;
        const next = new Map(current);
        next.set(pageNumber, windowKey);
        return next;
      });
      console.error(`Failed to render PDF thumbnail ${pageNumber}`, renderError);
    },
    [windowKey],
  );

  const handleNavigate = useCallback(
    (pageNumber: number) => {
      suppressAutoScrollRef.current = true;
      onNavigate(pageNumber);
    },
    [onNavigate],
  );

  const canvasSet = useMemo(() => new Set(canvasPages), [canvasPages]);

  return (
    <div data-testid="pdf-thumbnails" className="flex h-full min-h-0 flex-col">
      <div data-testid="pdf-thumbnails-scroll" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="flex flex-col gap-2">
          {sizes.map((size) => {
            const geometry = thumbnailGeometry(size, THUMBNAIL_WIDTH_PX);
            const active = size.pageNumber === currentPage;
            let state: "unloaded" | "rendering" | "rendered" | "error" = "unloaded";
            if (failedInWindow(size.pageNumber)) {
              state = "error";
            } else if (canvasSet.has(size.pageNumber)) {
              state = renderedThumbs.has(size.pageNumber) ? "rendered" : "rendering";
            }
            return (
              <div
                key={size.pageNumber}
                ref={(element) => registerCell(size.pageNumber, element)}
                data-pdf-thumb-slot={size.pageNumber}
                data-thumb-state={state}
                data-thumb-active={active || undefined}
              >
                <button
                  type="button"
                  aria-current={active || undefined}
                  aria-label={`Go to page ${size.pageNumber}`}
                  onClick={() => handleNavigate(size.pageNumber)}
                  className="block w-full rounded-md p-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50 aria-current:bg-accent"
                >
                  <span
                    style={{ height: `${geometry.height}px` }}
                    className="flex w-full items-center justify-center overflow-hidden rounded-sm border bg-white"
                  >
                    {canvasSet.has(size.pageNumber) && (
                      <PdfPageCanvas
                        document={document}
                        pageNumber={size.pageNumber}
                        width={geometry.width}
                        height={geometry.height}
                        scale={THUMBNAIL_WIDTH_PX / size.width}
                        testId="pdf-thumbnail"
                        onPageRendered={handleThumbRendered}
                        onPageError={handleThumbError}
                      />
                    )}
                    {state === "error" && <span className="text-xs text-destructive">Failed</span>}
                  </span>
                  <span className="mt-1 block text-center text-xs text-muted-foreground tabular-nums">
                    {size.pageNumber}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
