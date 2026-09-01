import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useShortcut } from "@/lib/shortcuts";
import { pdfWorkerSrc } from "@/lib/pdf/pdfEngine";
import { useReader } from "@/state/readerState";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "../placeholderDocument";
import { useFitWidthScale } from "./hooks/useFitWidthScale";
import { usePdfDocument } from "./hooks/usePdfDocument";
import { usePdfGeometry } from "./hooks/usePdfGeometry";
import { usePdfPersistence } from "./hooks/usePdfPersistence";
import {
  READING_ANCHOR_RATIO,
  setScrollTop,
  usePdfScrollTracking,
  type PdfAnchorInfo,
} from "./hooks/usePdfScrollTracking";
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
 * fit-width layout scale (useFitWidthScale), slot rendering
 * (PdfDocumentView/PdfPageSlot/PdfPageCanvas), toolbar state (PdfToolbar),
 * and persistence (usePdfPersistence). Outlines, annotations, and search
 * stay out of scope.
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

  // Layout scale = fit-width base × user zoom multiplier (§ fit width).
  // The reference page is page 1; wider pages in mixed documents overflow
  // horizontally instead of shrinking the fit reference.
  const referencePageWidth = sizes?.[0]?.width ?? 0;
  const { scale: fitScale, contentAreaRef } = useFitWidthScale(referencePageWidth);
  const scale = fitScale * zoom;

  // Initialization sequence (§ lifecycle): DOCUMENT_READY → LAYOUT_READY →
  // POSITION_RESTORED → INTERACTIVE. The document surface renders only once
  // the saved position has been applied, so a reader never flashes page 1
  // before jumping to the restored location.
  const [restored, setRestored] = useState(false);
  usePdfPersistence({
    bookId: book.id,
    enabled: layoutReady,
    currentPage,
    position,
    pageCount: effectivePageCount,
    onRestored: useCallback(
      (savedPage: number | null) => {
        if (savedPage !== null) {
          setPosition(pageToPosition(savedPage, effectivePageCount));
        }
        setRestored(true);
      },
      [effectivePageCount, setPosition],
    ),
  });
  const interactive = layoutReady && restored;

  const slots = useMemo(
    () => (sizes ? layoutSlots(displayedSizes(sizes, scale)) : []),
    [sizes, scale],
  );

  // Rendering policy, modeled on the official PDF.js viewer's
  // PDFRenderingQueue (pdfjs-dist web/pdf_viewer.mjs): the worker
  // rasterizes serially, so N concurrent render() calls are an illusion —
  // they just queue FIFO and the page the user is looking at can wait
  // behind up to N-1 others (worst case behind several multi-second image
  // decodes). Instead:
  //
  //   1. one render runs at a time (serialized at the call sites);
  //   2. the reading anchor page has absolute priority, then visible pages
  //      (closest first);
  //   3. exactly ONE prerender page beyond the viewport is attempted, and
  //      only while nothing visible needs rendering;
  //   4. a superseded in-flight render is simply unmounted (cancelled).
  //
  // Completed canvases stay mounted while their page remains inside the
  // virtualization window (anchor ∪ visible ∪ preload), bounded by
  // MAX_ACTIVE_CANVASES; distant pages keep only their geometry slots.
  const renderOrder = useMemo(() => {
    const active = [...new Set([currentPage, ...visiblePages])].sort(
      (a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage),
    );
    const preloaded = [...preloadPages]
      .sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage))
      .find((page) => !active.includes(page));
    if (preloaded !== undefined) active.push(preloaded);
    return active.slice(0, MAX_ACTIVE_CANVASES);
  }, [currentPage, visiblePages, preloadPages]);

  const canvasPages = useMemo(() => {
    const window = new Set(renderOrder);
    const completed = [...renderedPages].filter((page) => window.has(page));
    const next = renderOrder.find((page) => !renderedPages.has(page) && !failedPages.has(page));
    return next === undefined ? completed : [...completed, next];
  }, [renderOrder, renderedPages, failedPages]);

  // Measure pages as they approach visibility so slot estimates become real
  // dimensions before their canvases render (lazy geometry correction).
  useEffect(() => {
    if (!layoutReady || (visiblePages.size === 0 && preloadPages.size === 0)) return;
    measurePages([...visiblePages, ...preloadPages]);
  }, [layoutReady, measurePages, visiblePages, preloadPages]);

  // Re-anchor after layout-scale changes (zoom multiplier, window resize,
  // fit-width recalculation): the anchor's page + in-page fraction — kept
  // current by the scroll tracker — is mapped onto the rescaled layout, so
  // the user keeps reading at the exact same spot (§ zoom preserves the
  // reading position) instead of falling back to the page's top edge.
  const activeSlotRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef<HTMLDivElement | null>(null);
  const anchorInfoRef = useRef<PdfAnchorInfo | null>(null);
  const scrollReportedPageRef = useRef<number | null>(null);
  const previousPageRef = useRef(currentPage);
  const previousScaleRef = useRef(scale);
  const mountedRef = useRef(false);

  const reanchorByFraction = useCallback(() => {
    const container = scrollContainerRef?.current ?? null;
    const documentEl = documentRef.current;
    const info = anchorInfoRef.current;
    if (!container || !documentEl || !info || slots.length === 0) {
      activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
      return;
    }
    const slot = slots.find((candidate) => candidate.pageNumber === info.page) ?? slots[0];
    if (!slot) return;
    const targetAnchor = slot.top + info.fraction * slot.height;
    const documentTop =
      documentEl.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    setScrollTop(
      container,
      targetAnchor + documentTop - container.clientHeight * READING_ANCHOR_RATIO,
    );
  }, [scrollContainerRef, slots]);

  // Keep the latest re-anchoring logic reachable from the effect below
  // without re-running that effect on every slots change (geometry
  // corrections must never yank the viewport).
  const reanchorRef = useRef<() => void>(() => {});
  useEffect(() => {
    reanchorRef.current = reanchorByFraction;
  });

  // The loop guard: a page change that *originated from scrolling* must not
  // scroll back. The scroll tracker stamps every page it reports; if the
  // observed change matches the last scroll report, it is the user's own
  // scroll and re-anchoring is skipped. Scale changes re-anchor by fraction.
  useEffect(() => {
    const pageChanged = previousPageRef.current !== currentPage;
    const scaleChanged = previousScaleRef.current !== scale;
    previousPageRef.current = currentPage;
    previousScaleRef.current = scale;

    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (pageChanged && !scaleChanged && scrollReportedPageRef.current === currentPage) {
      return;
    }
    if (scaleChanged) {
      reanchorRef.current();
      return;
    }
    activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [currentPage, scale]);

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
    anchorInfoRef,
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
  // the visible pages while evicted slots simply resize their reservations.
  const changeZoom = (steps: number) => {
    setZoomIndex((index) => Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + steps)));
    setRenderedPages(new Set());
    setFailedPages(new Set());
  };

  // Keyboard zoom (§ reader keyboard): +/= in, - out. The shell does not
  // bind these, so there is no conflict with global reader shortcuts.
  const keyboardZoomRef = useRef<(steps: number) => void>(null);
  useEffect(() => {
    keyboardZoomRef.current = changeZoom;
  });
  useShortcut("+", () => keyboardZoomRef.current?.(1));
  useShortcut("=", () => keyboardZoomRef.current?.(1));
  useShortcut("-", () => keyboardZoomRef.current?.(-1));

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

  if (!interactive || !pdfDocument) {
    return (
      <div data-testid="pdf-reader" className="mx-auto max-w-3xl px-6 py-8">
        <p data-testid="pdf-loading" className="text-center text-sm text-muted-foreground">
          Loading {book.title}…
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="pdf-reader"
      data-pdf-worker-src={pdfWorkerSrc()}
      className="flex flex-col items-stretch px-6 py-4"
    >
      <PdfToolbar
        pageNumber={currentPage}
        pageCount={effectivePageCount}
        zoomPercent={Math.round(zoom * 100)}
        canZoomIn={zoomIndex < ZOOM_LEVELS.length - 1}
        canZoomOut={zoomIndex > 0}
        onPrev={() => goToPage(currentPage - 1)}
        onNext={() => goToPage(currentPage + 1)}
        onZoomIn={() => changeZoom(1)}
        onZoomOut={() => changeZoom(-1)}
      />
      <PdfDocumentView
        document={pdfDocument}
        slots={slots}
        renderPages={canvasPages}
        anchorPage={currentPage}
        scale={scale}
        renderedPages={renderedPages}
        failedPages={failedPages}
        onPageRendered={handlePageRendered}
        onPageError={handlePageError}
        registerSlot={registerSlot}
        registerAnchorSlot={registerActiveSlot}
        documentRef={documentRef}
        contentAreaRef={contentAreaRef}
      />
    </div>
  );
}
