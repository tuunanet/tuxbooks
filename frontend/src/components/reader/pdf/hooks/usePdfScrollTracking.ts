import { useEffect, useRef, type RefObject } from "react";
import { pageAtOffset, type LayoutSlot } from "../pdfLayout";

/**
 * Where the reading anchor sits in the viewport: 25% of the viewport height
 * below its top edge. The current page is the page containing the anchor —
 * a deterministic, monotonic rule while scrolling (no oscillation inside a
 * page, no dependence on which canvas painted last).
 */
export const READING_ANCHOR_RATIO = 0.25;

interface PdfScrollTrackingOptions {
  /** The scrollable reader container (owned by ReaderShell). */
  containerRef: RefObject<HTMLElement | null>;
  /** The document element whose slot tops the layout math describes. */
  documentRef: RefObject<HTMLElement | null>;
  slots: LayoutSlot[];
  enabled: boolean;
  onPageChange: (pageNumber: number) => void;
}

/**
 * Tracks the current page from scroll position. Raw scroll events only
 * schedule one requestAnimationFrame sample; the application-state callback
 * fires only when the sampled page actually changes, so scrolling never
 * causes per-event React updates.
 */
export function usePdfScrollTracking({
  containerRef,
  documentRef,
  slots,
  enabled,
  onPageChange,
}: PdfScrollTrackingOptions): void {
  const slotsRef = useRef(slots);
  useEffect(() => {
    slotsRef.current = slots;
  });
  const onPageChangeRef = useRef(onPageChange);
  useEffect(() => {
    onPageChangeRef.current = onPageChange;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    let frame = 0;

    const sample = () => {
      frame = 0;
      const documentEl = documentRef.current;
      if (!documentEl) return;
      // The document element's top in content coordinates is scroll-
      // invariant in the live DOM; anchor is then expressed in the same
      // document coordinates the layout slots use.
      const documentTop =
        documentEl.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      const anchor =
        container.scrollTop + container.clientHeight * READING_ANCHOR_RATIO - documentTop;
      const page = pageAtOffset(anchor, slotsRef.current);
      if (page !== null) onPageChangeRef.current(page);
    };

    const requestSample = () => {
      if (!frame) frame = requestAnimationFrame(sample);
    };
    const cancelSample = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    container.addEventListener("scroll", requestSample, { passive: true });
    window.addEventListener("resize", requestSample);
    sample();

    return () => {
      container.removeEventListener("scroll", requestSample);
      window.removeEventListener("resize", requestSample);
      cancelSample();
    };
  }, [containerRef, documentRef, enabled]);
}
