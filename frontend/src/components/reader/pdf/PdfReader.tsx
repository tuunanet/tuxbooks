import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReader } from "@/state/readerState";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "../placeholderDocument";
import { usePdfDocument } from "./hooks/usePdfDocument";
import { usePdfGeometry } from "./hooks/usePdfGeometry";
import { PdfDocumentView } from "./PdfDocumentView";
import { PdfToolbar } from "./PdfToolbar";
import { displayedSizes, layoutSlots } from "./pdfLayout";
import { pageToPosition, positionToPage } from "./pdfPages";
import type { Book } from "@/types/domain";

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2] as const;
const DEFAULT_ZOOM_INDEX = 2;

interface PdfReaderProps {
  book: Book;
  /** Reports the real page count once the document has loaded. */
  onDocumentLoad?: (pageCount: number) => void;
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
export function PdfReader({ book, onDocumentLoad }: PdfReaderProps) {
  const { position, setPosition } = useReader();
  const {
    status,
    document: pdfDocument,
    pageCount,
    error,
  } = usePdfDocument(book.id, onDocumentLoad);
  const { sizes, measurePages } = usePdfGeometry(pdfDocument, pageCount);

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

  // Measure the pages around the reading position so slot estimates become
  // real dimensions before the reader reaches them (lazy geometry
  // correction). Visibility-driven measurement extends this in Phase 2.
  useEffect(() => {
    if (!layoutReady) return;
    measurePages([currentPage - 1, currentPage, currentPage + 1]);
  }, [layoutReady, measurePages, currentPage]);

  // Keep the named page visible when the position changes from outside the
  // document (keyboard navigation, drawer jumps) — and re-anchor after zoom
  // changes: slot heights rescale with zoom, so without re-anchoring the
  // viewport would sit at a stale pixel offset showing a different, unloaded
  // slot while the page indicator still names the old page. The active
  // page's top edge is the preserved logical position (§ zoom preserves the
  // reading page); Phase 5 refines this to a viewport-fraction anchor.
  const activeSlotRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [currentPage, zoom]);

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
        activePage={currentPage}
        scale={zoom}
        renderedPages={renderedPages}
        failedPages={failedPages}
        onPageRendered={handlePageRendered}
        onPageError={handlePageError}
        registerActiveSlot={registerActiveSlot}
      />
    </div>
  );
}
