import { useCallback, useEffect, useRef, useState } from "react";
import type { PdfDocument } from "@/lib/pdf/pdfEngine";
import { estimatePageSizes, medianPageSize, type PageSize } from "../pdfLayout";

/**
 * Eager full-document measurement: documents up to
 * EAGER_MEASURE_PAGE_LIMIT pages get every page's real size fetched in
 * EAGER_MEASURE_WAVE_SIZE waves right after the first page renders — the
 * policy mainstream PDF viewers converge on, with the wave size (250) and
 * the lazy-page limit (5000) mirroring common viewer practice. Slot
 * heights therefore stop correcting long before a user can move to the
 * scrollbar, so the native thumb's mapping never sees scrollHeight move
 * mid-drag — the confirmed jump mechanism (T1, ticket tuxbooks-x27.5,
 * capture evidence in docs/research/pdf-viewer-perf-findings.md, Symptom
 * 2). Documents above the limit stay on the lazy on-approach correction.
 */
const EAGER_MEASURE_PAGE_LIMIT = 5000;
const EAGER_MEASURE_WAVE_SIZE = 250;

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
   * Superseded by the eager sweep below the page limit, this remains the
   * correction path for larger documents and for pages the sweep could not
   * measure.
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

/** Fetch one page's real size at scale 1. */
async function measurePage(document: PdfDocument, pageNumber: number): Promise<PageSize> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  return { pageNumber, width: viewport.width, height: viewport.height };
}

/**
 * Merge real page dimensions into the current geometry. Shared by the
 * eager sweep and the lazy on-approach path so both corrections stay in
 * lockstep; the document check is the generation guard (results from a
 * superseded document never replace the current geometry).
 */
function applyCorrections(
  current: GeometryState,
  document: PdfDocument,
  measured: PageSize[],
): GeometryState {
  if (current.document !== document || current.sizes === null) return current;
  const corrections = new Map(measured.map((sample) => [sample.pageNumber, sample]));
  const sizes = current.sizes.map((size) => {
    const correction = corrections.get(size.pageNumber);
    return correction ? correction : size;
  });
  return { document, sizes };
}

/**
 * Page geometry for the continuous layout. Every page is first estimated
 * from a small opening sample (pages 1, 2, and the last page, median by
 * area) so the whole document reserves its space immediately; real
 * dimensions replace estimates as pages are measured. Below
 * EAGER_MEASURE_PAGE_LIMIT the measurement is a full-document sweep that
 * starts once the first page has rendered (the point mainstream viewers
 * pick); above it, pages are corrected lazily as they
 * approach visibility. Estimating from page 1 alone made a document with
 * an odd first page (a wide cover) reserve every page at the cover's box,
 * so each ordinary page visibly snapped narrower as it was measured: a
 * width flash on every approach. The sampled pages keep their REAL sizes
 * in `sizes`, which also anchors `documentMaxPageSize`, the fit-scale
 * reference, exactly as page 1's real size did before: the reference never
 * changes when a later page is measured unless that page is genuinely
 * larger than everything sampled, which is the pre-existing rescale
 * behavior.
 */
export function usePdfGeometry(
  document: PdfDocument | null,
  pageCount: number,
  firstPainted: boolean,
): PdfGeometry {
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
        sampleNumbers.map((pageNumber) => measurePage(document, pageNumber)),
      );
      if (cancelled || samples.length === 0) return;
      const first = samples[0] ?? { pageNumber: 0, width: 0, height: 0 };
      const reference = medianPageSize(samples) ?? { ...first };
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

  // Eager full-document measurement (see the constants above). Gated on
  // first paint so the sweep never queues ahead of page 1
  // on the worker — the same ordering rule as the outline request
  // (docs/PDF.md, § first-page priority). One geometry commit per wave, so
  // the layout converges in a handful of beats right after open instead of
  // correcting slot heights for as long as the user scrolls. A page whose
  // measurement fails stays unmeasured — the lazy on-approach path retries
  // it — and the sweep carries on with the rest of its wave.
  useEffect(() => {
    if (!document || pageCount === 0 || !firstPainted) return;
    if (pageCount > EAGER_MEASURE_PAGE_LIMIT) return;
    let cancelled = false;

    void (async () => {
      for (let start = 1; start <= pageCount; start += EAGER_MEASURE_WAVE_SIZE) {
        const wave: number[] = [];
        for (
          let pageNumber = start;
          pageNumber < start + EAGER_MEASURE_WAVE_SIZE && pageNumber <= pageCount;
          pageNumber += 1
        ) {
          if (!measuredPagesRef.current.has(pageNumber)) wave.push(pageNumber);
        }
        if (wave.length === 0) continue;
        const measured = (
          await Promise.all(
            wave.map(async (pageNumber) => {
              try {
                return await measurePage(document, pageNumber);
              } catch {
                return null;
              }
            }),
          )
        ).filter((sample) => sample !== null);
        if (cancelled) return;
        if (measured.length > 0) {
          setState((current) => applyCorrections(current, document, measured));
          for (const sample of measured) measuredPagesRef.current.add(sample.pageNumber);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [document, pageCount, firstPainted]);

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
          pending.map((pageNumber) => measurePage(document, pageNumber)),
        );
        if (measured.length === 0) return;
        setState((current) => applyCorrections(current, document, measured));
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
