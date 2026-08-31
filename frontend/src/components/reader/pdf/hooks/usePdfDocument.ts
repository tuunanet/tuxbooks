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

  const [status, setStatus] = useState<PdfDocumentStatus>("loading");
  const [document_, setDocument] = useState<PdfDocument | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
        setDocument(loaded);
        setPageCount(loaded.numPages);
        setStatus("ready");
        onDocumentLoadRef.current?.(loaded.numPages);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (loaded) void closePdfDocument(loaded);
    };
  }, [bookId]);

  return { status, document: document_, pageCount, error };
}
