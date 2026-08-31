import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  closePdfDocument,
  openPdfDocument,
  RenderingCancelledException,
  type PdfDocument,
  type PdfRenderTask,
} from "@/lib/pdf/pdfEngine";
import { getBookBytes } from "@/lib/tauri";
import { useReader } from "@/state/readerState";
import { pageToPosition, positionToPage } from "./pdfPages";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "./placeholderDocument";
import type { Book } from "@/types/domain";

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2] as const;
const DEFAULT_ZOOM_INDEX = 2;

interface PdfReaderProps {
  book: Book;
  /** Reports the real page count once the document has loaded. */
  onDocumentLoad?: (pageCount: number) => void;
}

/**
 * PDF reading surface. Loads the book's bytes through the `get_book_bytes`
 * command and renders pages to a canvas via the PDF.js engine. The reading
 * position owned by ReaderProvider is the single source of truth: page
 * navigation writes positions, keyboard and outline navigation read them.
 * Outlines, annotations, and search stay out of scope for now.
 */
export function PdfReader({ book, onDocumentLoad }: PdfReaderProps) {
  const { position, setPosition } = useReader();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<PdfRenderTask | null>(null);

  const onDocumentLoadRef = useRef(onDocumentLoad);
  useEffect(() => {
    onDocumentLoadRef.current = onDocumentLoad;
  });

  const [pdfDocument, setPdfDocument] = useState<PdfDocument | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);

  const zoom = ZOOM_LEVELS[zoomIndex] as number;
  const effectivePageCount = pageCount > 0 ? pageCount : PDF_PLACEHOLDER_PAGE_COUNT;
  const currentPage = positionToPage(position, effectivePageCount);

  // Load the document bytes for this book; the effect owns the document
  // lifetime and destroys it when the reader unmounts or switches books.
  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | null = null;

    (async () => {
      try {
        const bytes = await getBookBytes(book.id);
        // PDF.js transfers the buffer to its worker; it is not reused here.
        loaded = await openPdfDocument(new Uint8Array(bytes));
        if (cancelled) {
          await closePdfDocument(loaded);
          return;
        }
        setPdfDocument(loaded);
        setPageCount(loaded.numPages);
        onDocumentLoadRef.current?.(loaded.numPages);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      if (loaded) void closePdfDocument(loaded);
    };
  }, [book.id]);

  // Render the current page at the current zoom. Renders on one canvas are
  // serialized: a superseded task is cancelled and given time to unwind
  // before the next one starts (PDF.js refuses concurrent renders per canvas).
  useEffect(() => {
    const canvas = canvasRef.current;
    const doc = pdfDocument;
    if (!doc || !canvas) return;

    let cancelled = false;

    (async () => {
      const previous = renderTaskRef.current;
      if (previous) {
        previous.cancel();
        await previous.promise.catch(() => {});
      }

      const page = await doc.getPage(currentPage);
      const viewport = page.getViewport({ scale: zoom });
      const ratio = window.devicePixelRatio || 1;

      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context is unavailable");

      // `canvas` is the v6 render parameter; PDF.js acquires the 2D context
      // from it. The transform maps viewport units onto device pixels.
      const task = page.render({
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      renderTaskRef.current = task;
      await task.promise;
    })().catch((err: unknown) => {
      if (cancelled || err instanceof RenderingCancelledException) return;
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdfDocument, currentPage, zoom]);

  const goToPage = (page: number) => {
    const clamped = Math.max(1, Math.min(effectivePageCount, page));
    setPosition(pageToPosition(clamped, effectivePageCount));
  };

  if (error) {
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

  if (!pdfDocument) {
    return (
      <div data-testid="pdf-reader" className="mx-auto max-w-3xl px-6 py-8">
        <p data-testid="pdf-loading" className="text-center text-sm text-muted-foreground">
          Loading {book.title}…
        </p>
      </div>
    );
  }

  return (
    <div data-testid="pdf-reader" className="flex min-h-full flex-col items-center px-6 py-4">
      <div className="mb-3 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="pdf-prev"
          aria-label="Previous page"
          disabled={currentPage <= 1}
          onClick={() => goToPage(currentPage - 1)}
        >
          <span aria-hidden="true">‹</span>
        </Button>
        <span
          data-testid="pdf-page-indicator"
          className="px-2 text-xs text-muted-foreground tabular-nums"
        >
          Page {currentPage} of {pageCount}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="pdf-next"
          aria-label="Next page"
          disabled={currentPage >= pageCount}
          onClick={() => goToPage(currentPage + 1)}
        >
          <span aria-hidden="true">›</span>
        </Button>

        <span className="mx-2 h-4 w-px bg-border" aria-hidden="true" />

        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="pdf-zoom-out"
          aria-label="Zoom out"
          disabled={zoomIndex === 0}
          onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
        >
          <Minus />
        </Button>
        <span
          data-testid="pdf-zoom-level"
          className="w-10 text-center text-xs text-muted-foreground tabular-nums"
        >
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="pdf-zoom-in"
          aria-label="Zoom in"
          disabled={zoomIndex === ZOOM_LEVELS.length - 1}
          onClick={() => setZoomIndex((index) => Math.min(ZOOM_LEVELS.length - 1, index + 1))}
        >
          <Plus />
        </Button>
      </div>

      <div className="flex min-h-0 w-full flex-1 justify-center overflow-auto">
        <canvas
          ref={canvasRef}
          data-testid="pdf-canvas"
          data-page={currentPage}
          className="max-w-full rounded-sm border bg-white shadow-sm"
        />
      </div>
    </div>
  );
}
