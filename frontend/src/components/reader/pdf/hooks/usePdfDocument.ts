import { useEffect, useRef, useState } from "react";
import { closePdfDocument, openPdfDocumentFromBook, type PdfDocument } from "@/lib/pdf/pdfEngine";

export type PdfDocumentStatus = "loading" | "ready" | "error";

export interface PdfDocumentState {
  status: PdfDocumentStatus;
  document: PdfDocument | null;
  pageCount: number;
  error: string | null;
  /**
   * Milliseconds from open start to the document being parsed and page
   * count known (the `open=` segment of the PDF-open timeline); null until
   * the document is ready or the open fails.
   */
  openMs: number | null;
  /** Monotonic timestamp of the current open's start (telemetry anchor). */
  openStartedAt: number | null;
}
interface PdfDocumentSnapshot extends PdfDocumentState {
  bookId: number;
  /** Monotonic timestamp the current open started (performance.now). */
  openStartedAt: number | null;
}

/**
 * Opens a book's PDF through the engine's range-backed stream
 * (`openPdfDocumentFromBook`): the worker pulls only the byte ranges MuPDF
 * needs, so the document opens without the whole file crossing the bridge.
 * The hook owns the document lifetime: switching books or unmounting
 * destroys the document, and a load that finishes after its effect was
 * superseded never touches React state. Unexpected worker death re-opens
 * the document once on a fresh worker (the range-backed source holds no
 * bytes to lose); a second death surfaces as a real error.
 */
export function usePdfDocument(
  bookId: number,
  onDocumentLoad?: (pageCount: number) => void,
): PdfDocumentState {
  const onDocumentLoadRef = useRef(onDocumentLoad);
  useEffect(() => {
    onDocumentLoadRef.current = onDocumentLoad;
  });

  const [openStartedAt, setOpenStartedAt] = useState<number | null>(null);

  const [snapshot, setSnapshot] = useState<PdfDocumentSnapshot>(() => ({
    bookId,
    status: "loading",
    document: null,
    pageCount: 0,
    error: null,
    openMs: null,
    openStartedAt: null,
  }));
  // Render-phase reset on book switch (same pattern as the reader's bitmap
  // cache): the previous document leaves state the moment the book id
  // changes, so a closed document can never serve a render while the next
  // one loads.
  if (snapshot.bookId !== bookId) {
    setSnapshot({
      bookId,
      status: "loading",
      document: null,
      pageCount: 0,
      error: null,
      openMs: null,
      openStartedAt: null,
    });
  }

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | null = null;
    let retries = 0;

    const fail = (err: unknown): void => {
      if (cancelled) return;
      setSnapshot((current) => ({
        ...current,
        error: err instanceof Error ? err.message : String(err),
        status: "error",
      }));
    };

    const open = async (): Promise<void> => {
      // The open anchor for the PDF-open telemetry (docs/performance.md):
      // everything on the open path is measured from this point.
      const startedAt = performance.now();
      setOpenStartedAt(startedAt);
      const doc = await openPdfDocumentFromBook(bookId, "pdf");
      if (cancelled) {
        await closePdfDocument(doc);
        return;
      }
      loaded = doc;
      // Worker death is a diagnostic failure (distinct from cancellation):
      // the range-backed source needs no retained bytes, so the document
      // re-opens on a fresh worker. One automatic attempt — a second death
      // is a real error, not something to loop on.
      doc.onWorkerFailed?.(() => {
        if (cancelled || loaded !== doc) return;
        loaded = null;
        if (retries >= 1) {
          fail(new Error("PDF worker failed and could not be recovered"));
          return;
        }
        retries += 1;
        void closePdfDocument(doc);
        setSnapshot((current) => ({ ...current, document: null, status: "loading" }));
        open().catch(fail);
      });
      const numPages = doc.numPages;
      const openMs = performance.now() - startedAt;
      // Read engine values outside the updater: state updaters must stay
      // pure, so a malformed engine result fails in this try/catch.
      setSnapshot((current) => ({
        ...current,
        document: doc,
        pageCount: numPages,
        status: "ready",
        openMs,
      }));
      onDocumentLoadRef.current?.(numPages);
    };

    open().catch(fail);

    return () => {
      cancelled = true;
      if (loaded) void closePdfDocument(loaded);
    };
  }, [bookId]);

  return {
    status: snapshot.status,
    document: snapshot.document,
    pageCount: snapshot.pageCount,
    error: snapshot.error,
    openMs: snapshot.openMs,
    /** Monotonic timestamp of the current open's start (telemetry anchor). */
    openStartedAt,
  };
}
