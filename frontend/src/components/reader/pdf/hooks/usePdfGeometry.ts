import { useCallback, useEffect, useRef, useState } from "react";
import type { PdfDocument } from "@/lib/pdf/pdfEngine";
import { estimatePageSizes, type PageSize } from "../pdfLayout";

interface GeometryState {
  document: PdfDocument | null;
  sizes: PageSize[] | null;
}

export interface PdfGeometry {
  /**
   * Per-page sizes in page units (points) at scale 1, or null until the
   * reference page has been measured for the current document.
   */
  sizes: PageSize[] | null;
  /**
   * Replace estimates with real page dimensions. Already-measured pages are
   * skipped; corrections land after the requested pages have been measured.
   */
  measurePages: (pageNumbers: number[]) => void;
}

/**
 * Page geometry for the continuous layout. Every page is first estimated
 * from page 1 so the whole document reserves its space immediately; real
 * dimensions replace estimates as pages are measured (lazy correction).
 */
export function usePdfGeometry(document: PdfDocument | null, pageCount: number): PdfGeometry {
  const [state, setState] = useState<GeometryState>({ document: null, sizes: null });
  const measuredPagesRef = useRef<Set<number>>(new Set());

  // Measure the reference page and estimate the rest of the document.
  useEffect(() => {
    if (!document || pageCount === 0) return;
    measuredPagesRef.current = new Set();
    let cancelled = false;

    (async () => {
      const page = await document.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      if (cancelled) return;
      measuredPagesRef.current.add(1);
      setState({
        document,
        sizes: estimatePageSizes(pageCount, { width: viewport.width, height: viewport.height }),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [document, pageCount]);

  const measurePages = useCallback(
    (pageNumbers: number[]) => {
      const pending = pageNumbers.filter(
        (pageNumber) =>
          pageNumber >= 1 && pageNumber <= pageCount && !measuredPagesRef.current.has(pageNumber),
      );
      if (!document || pending.length === 0) return;

      void (async () => {
        const measured = new Map<number, { width: number; height: number }>();
        for (const pageNumber of pending) {
          const page = await document.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1 });
          measured.set(pageNumber, { width: viewport.width, height: viewport.height });
        }
        if (measured.size === 0) return;
        // The document check is the generation guard: results from a
        // superseded document never replace the current geometry.
        setState((current) => {
          if (current.document !== document || current.sizes === null) return current;
          const sizes = current.sizes.map((size) => {
            const correction = measured.get(size.pageNumber);
            return correction
              ? { pageNumber: size.pageNumber, width: correction.width, height: correction.height }
              : size;
          });
          return { document, sizes };
        });
        for (const pageNumber of measured.keys()) measuredPagesRef.current.add(pageNumber);
      })();
    },
    [document, pageCount],
  );

  return { sizes: state.document === document ? state.sizes : null, measurePages };
}
