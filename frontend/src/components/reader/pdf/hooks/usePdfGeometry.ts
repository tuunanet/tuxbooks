import { useCallback, useEffect, useRef, useState } from "react";
import type { PdfDocument } from "@/lib/pdf/pdfEngine";
import { estimatePageSizes, medianPageSize, type PageSize } from "../pdfLayout";

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
  /**
   * True once real dimensions have replaced a page's initial estimate. The
   * presentation preload gates on this so it never rasterizes a neighbour at
   * the wrong (estimated) scale: the measurement lands a render later, and
   * the resulting `sizes` change re-runs the gate.
   */
  isMeasured: (pageNumber: number) => boolean;
}

/**
 * Page geometry for the continuous layout. Every page is first estimated
 * from a small opening sample (pages 1, 2, and the last page, median by
 * area) so the whole document reserves its space immediately; real
 * dimensions replace estimates as pages are measured (lazy correction).
 * Estimating from page 1 alone made a document with an odd first page (a
 * wide cover) reserve every page at the cover's box, so each ordinary page
 * visibly snapped narrower as it was measured: a width flash on every
 * approach. The sampled pages keep their REAL sizes in `sizes`, which also
 * anchors `documentMaxPageSize`, the fit-scale reference, exactly as
 * page 1's real size did before: the reference never changes when a
 * later page is measured unless that page is genuinely larger than
 * everything sampled, which is the pre-existing rescale behavior.
 */
export function usePdfGeometry(document: PdfDocument | null, pageCount: number): PdfGeometry {
  const [state, setState] = useState<GeometryState>({ document: null, sizes: null });
  const measuredPagesRef = useRef<Set<number>>(new Set());

  // Measure the opening sample and estimate the rest of the document. The
  // sample runs in parallel: three engine round-trips at once, one beat.
  useEffect(() => {
    if (!document || pageCount === 0) return;
    measuredPagesRef.current = new Set();
    let cancelled = false;

    (async () => {
      const sampleNumbers = [...new Set([1, 2, pageCount])].filter(
        (pageNumber) => pageNumber >= 1 && pageNumber <= pageCount,
      );
      const samples = await Promise.all(
        sampleNumbers.map(async (pageNumber) => {
          const page = await document.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1 });
          return { pageNumber, width: viewport.width, height: viewport.height };
        }),
      );
      if (cancelled || samples.length === 0) return;
      const first = samples[0] ?? { width: 0, height: 0 };
      const reference = medianPageSize(samples) ?? { width: first.width, height: first.height };
      const measured = new Map(samples.map((sample) => [sample.pageNumber, sample]));
      setState({
        document,
        sizes: estimatePageSizes(pageCount, reference).map((size) => {
          const sample = measured.get(size.pageNumber);
          return sample ? { ...sample } : size;
        }),
      });
      for (const pageNumber of measured.keys()) measuredPagesRef.current.add(pageNumber);
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
        // One parallel batch, not a sequential queue: the corrections land
        // after a single round-trip, so a fast scroll cannot outrun the
        // measurement of pages that were already inside the preload margin.
        const measured = await Promise.all(
          pending.map(async (pageNumber) => {
            const page = await document.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            return { pageNumber, width: viewport.width, height: viewport.height };
          }),
        );
        if (measured.length === 0) return;
        // The document check is the generation guard: results from a
        // superseded document never replace the current geometry.
        setState((current) => {
          if (current.document !== document || current.sizes === null) return current;
          const corrections = new Map(measured.map((sample) => [sample.pageNumber, sample]));
          const sizes = current.sizes.map((size) => {
            const correction = corrections.get(size.pageNumber);
            return correction
              ? { pageNumber: size.pageNumber, width: correction.width, height: correction.height }
              : size;
          });
          return { document, sizes };
        });
        for (const sample of measured) measuredPagesRef.current.add(sample.pageNumber);
      })();
    },
    [document, pageCount],
  );

  const isMeasured = useCallback(
    (pageNumber: number) => measuredPagesRef.current.has(pageNumber),
    [],
  );

  return { sizes: state.document === document ? state.sizes : null, measurePages, isMeasured };
}
