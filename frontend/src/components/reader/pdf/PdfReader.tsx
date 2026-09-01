import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useReader } from "@/state/readerState";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "../placeholderDocument";
import { usePdfDocument } from "./hooks/usePdfDocument";
import { usePdfGeometry } from "./hooks/usePdfGeometry";
import { usePdfScrollTracking } from "./hooks/usePdfScrollTracking";
import { usePdfVirtualization } from "./hooks/usePdfVirtualization";
import { PdfDocumentView } from "./PdfDocumentView";
import { PdfToolbar } from "./PdfToolbar";
import { displayedSizes, layoutSlots } from "./pdfLayout";
import { pageToPosition, positionToPage } from "./pdfPages";
import type { Book } from "@/types/domain";

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2] as const;
const DEFAULT_ZOOM_INDEX = 2;

/** Upper bound on simultaneously active page canvases (the render budget). */
const MAX_ACTIVE_CANVASES = 8;

interface PdfReaderProps {
  book: Book;
  /** Reports the real page count once the document has loaded. */
  onDocumentLoad?: (pageCount: number) => void;
  /** The reader's scroll container, owned by ReaderShell. */
  scrollContainerRef?: RefObject<HTMLElement | null>;
}

/**
 * PDF reading surface: a continuous, vertically scrolling document. The
 * reading position owned by ReaderProvider is the single source of truth —
 * this component renders the document according to that position and
 * reports page changes back. Responsibilities live in the pdf/ modules:
 * document loading (usePdfDocument), geometry (usePdfGeometry + pdfLayout),
 * slot rendering (PdfDocumentView/PdfPageSlot/PdfPageCanvas), and toolbar
 * state (PdfToolbar). Outlines, annotations, and search stay out of scope.
 */
export function PdfReader({ book, onDocumentLoad, scrollContainerRef }: PdfReaderProps) {
  const { position, setPosition } = useReader();
  const {
    status,
    document: pdfDocument,
    pageCount,
    error,
  } = usePdfDocument(book.id, onDocumentLoad);
  const { sizes, measurePages } = usePdfGeometry(pdfDocument, pageCount);
  const { registerSlot, visiblePages, preloadPages } = usePdfVirtualization();

  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const [renderedPages, setRenderedPages] = useState<ReadonlySet<number>>(() => new Set());
  const [failedPages, setFailedPages] = useState<ReadonlySet<number>>(() => new Set());

  const zoom = ZOOM_LEVELS[zoomIndex] as number;
  const effectivePageCount = pageCount > 0 ? pageCount : PDF_PLACEHOLDER_PAGE_COUNT;
  const currentPage = positionToPage(position, effectivePageCount);
  const layoutReady = status === "ready" && sizes !== null;

  const slots = useMemo(
    () => (sizes ? layoutSlots(displayedSizes(sizes, zoom)) : []),
    [sizes, zoom],
  );

  // The bounded render set: the current page first (it must always render,
  // even far from any scroll event), then visible pages, then preloading
  // pages — closest to the reading position first, capped at the budget.
  // Distant pages keep only their geometry slots; their canvases are gone.
  const renderPages = useMemo(() => {
    const candidates = new Set<number>([currentPage]);
    for (const page of visiblePages) candidates.add(page);
    for (const page of preloadPages) candidates.add(page);
    return [...candidates]
      .sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage))
      .slice(0, MAX_ACTIVE_CANVASES);
  }, [currentPage, visiblePages, preloadPages]);

  // Measure pages as they approach visibility so slot estimates become real
  // dimensions before their canvases render (lazy geometry correction).
  useEffect(() => {
    if (!layoutReady || (visiblePages.size === 0 && preloadPages.size === 0)) return;
    measurePages([...visiblePages, ...preloadPages]);
  }, [layoutReady, measurePages, visiblePages, preloadPages]);

  // Keep the named page visible when the position changes from outside the
  // document (keyboard navigation, drawer jumps) — and re-anchor after zoom
  // changes: slot heights rescale with zoom, so without re-anchoring the
  // viewport would sit at a stale pixel offset showing a different, unloaded
  // slot while the page indicator still names the old page. The active
  // page's top edge is the preserved logical position (§ zoom preserves the
  // reading page); a viewport-fraction anchor can refine this later.
  //
  // The loop guard: a page change that *originated from scrolling* must not
  // scroll back. The scroll tracker stamps every page it reports; if the
  // observed change matches the last scroll report, it is the user's own
  // scroll and re-anchoring is skipped. Zoom-only changes always re-anchor.
  const activeSlotRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef<HTMLDivElement | null>(null);
  const scrollReportedPageRef = useRef<number | null>(null);
  const previousPageRef = useRef(currentPage);
  const previousZoomRef = useRef(zoom);
  const mountedRef = useRef(false);
  useEffect(() => {
    const pageChanged = previousPageRef.current !== currentPage;
    const zoomChanged = previousZoomRef.current !== zoom;
    previousPageRef.current = currentPage;
    previousZoomRef.current = zoom;

    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (pageChanged && !zoomChanged && scrollReportedPageRef.current === currentPage) {
      return;
    }
    activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [currentPage, zoom]);

  // Scroll-driven position reporting: the anchor rule decides the page, the
  // position is written back to ReaderProvider so the shell (footer, keyboard
  // stepping, pages drawer) stays consistent with what the user sees.
  const handleScrollPageChange = useCallback(
    (page: number) => {
      scrollReportedPageRef.current = page;
      setPosition(pageToPosition(page, effectivePageCount));
    },
    [effectivePageCount, setPosition],
  );
  usePdfScrollTracking({
    containerRef: scrollContainerRef ?? { current: null },
    documentRef,
    slots,
    enabled: layoutReady,
    onPageChange: handleScrollPageChange,
  });

  const registerActiveSlot = useCallback((element: HTMLDivElement | null) => {
    activeSlotRef.current = element;
  }, []);

  const handlePageRendered = useCallback((pageNumber: number) => {
    setRenderedPages((current) => {
      if (current.has(pageNumber)) return current;
      const next = new Set(current);
      next.add(pageNumber);
      return next;
    });
  }, []);

  const handlePageError = useCallback((pageNumber: number, renderError: unknown) => {
    setFailedPages((current) => {
      if (current.has(pageNumber)) return current;
      const next = new Set(current);
      next.add(pageNumber);
      return next;
    });
    console.error(`Failed to render PDF page ${pageNumber}`, renderError);
  }, []);

  const goToPage = (page: number) => {
    const clamped = Math.max(1, Math.min(effectivePageCount, page));
    setPosition(pageToPosition(clamped, effectivePageCount));
  };

  // A zoom change invalidates rendered canvases; the new scale re-renders
  // the active page while evicted slots simply resize their reservations.
  const changeZoom = (nextIndex: number) => {
    setZoomIndex(nextIndex);
    setRenderedPages(new Set());
    setFailedPages(new Set());
  };

  if (status === "error") {
    return (
      <div data-testid="pdf-reader" className="mx-auto max-w-3xl px-6 py-8">
        <p
          data-testid="pdf-error"
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          This PDF could not be opened: {error}
        </p>
      </div>
    );
  }

  if (!layoutReady || !pdfDocument) {
    return (
      <div data-testid="pdf-reader" className="mx-auto max-w-3xl px-6 py-8">
        <p data-testid="pdf-loading" className="text-center text-sm text-muted-foreground">
          Loading {book.title}…
        </p>
      </div>
    );
  }

  return (
    <div data-testid="pdf-reader" className="flex flex-col items-stretch px-6 py-4">
      <PdfToolbar
        pageNumber={currentPage}
        pageCount={effectivePageCount}
        zoomPercent={Math.round(zoom * 100)}
        canZoomIn={zoomIndex < ZOOM_LEVELS.length - 1}
        canZoomOut={zoomIndex > 0}
        onPrev={() => goToPage(currentPage - 1)}
        onNext={() => goToPage(currentPage + 1)}
        onZoomIn={() => changeZoom(zoomIndex + 1)}
        onZoomOut={() => changeZoom(zoomIndex - 1)}
      />
      <PdfDocumentView
        document={pdfDocument}
        slots={slots}
        renderPages={renderPages}
        anchorPage={currentPage}
        scale={zoom}
        renderedPages={renderedPages}
        failedPages={failedPages}
        onPageRendered={handlePageRendered}
        onPageError={handlePageError}
        registerSlot={registerSlot}
        registerAnchorSlot={registerActiveSlot}
        documentRef={documentRef}
      />
    </div>
  );
}
