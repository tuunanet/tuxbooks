import { useEffect, useRef, useState } from "react";
import { closePdfDocument, openPdfDocument, type PdfDocument } from "@/lib/pdf/pdfEngine";
import { getBookBytes } from "@/lib/tauri";

export type PdfDocumentStatus = "loading" | "ready" | "error";

export interface PdfDocumentState {
  status: PdfDocumentStatus;
  document: PdfDocument | null;
  pageCount: number;
  error: string | null;
}

interface PdfDocumentSnapshot extends PdfDocumentState {
  bookId: number;
}

/**
 * Loads a book's bytes through `get_book_bytes` and opens the PDF.js
 * document. The hook owns the document lifetime: switching books or
 * unmounting destroys the document, and a load that finishes after its
 * effect was superseded never touches React state.
 */
export function usePdfDocument(
  bookId: number,
  onDocumentLoad?: (pageCount: number) => void,
): PdfDocumentState {
  const onDocumentLoadRef = useRef(onDocumentLoad);
  useEffect(() => {
    onDocumentLoadRef.current = onDocumentLoad;
  });

  const [snapshot, setSnapshot] = useState<PdfDocumentSnapshot>(() => ({
    bookId,
    status: "loading",
    document: null,
    pageCount: 0,
    error: null,
  }));
  // Render-phase reset on book switch (same pattern as the reader's bitmap
  // cache): the previous document leaves state the moment the book id
  // changes, so a closed document can never serve a render while the next
  // one loads.
  if (snapshot.bookId !== bookId) {
    setSnapshot({ bookId, status: "loading", document: null, pageCount: 0, error: null });
  }

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | null = null;

    (async () => {
      try {
        const bytes = await getBookBytes(bookId);
        // PDF.js transfers the buffer to its worker; it is not reused here.
        loaded = await openPdfDocument(new Uint8Array(bytes));
        if (cancelled) {
          await closePdfDocument(loaded);
          return;
        }
        const opened = loaded;
        const numPages = opened.numPages;
        // Read engine values outside the updater: state updaters must stay
        // pure, so a malformed engine result fails in this try/catch.
        setSnapshot((current) => ({
          ...current,
          document: opened,
          pageCount: numPages,
          status: "ready",
        }));
        onDocumentLoadRef.current?.(numPages);
      } catch (err: unknown) {
        if (!cancelled) {
          setSnapshot((current) => ({
            ...current,
            error: err instanceof Error ? err.message : String(err),
            status: "error",
          }));
        }
      }
    })();

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
  };
}
