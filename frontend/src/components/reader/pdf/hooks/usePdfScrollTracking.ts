import { useEffect, useRef, type RefObject } from "react";
import { offsetForPage, pageAtOffset, type LayoutSlot } from "../pdfLayout";

/**
 * Where the reading anchor sits in the viewport: 25% of the viewport height
 * below its top edge. The current page is the page containing the anchor —
 * a deterministic, monotonic rule while scrolling (no oscillation inside a
 * page, no dependence on which canvas painted last).
 */
export const READING_ANCHOR_RATIO = 0.25;

/**
 * Imperative scroll write used by re-anchoring. Kept in one helper because
 * the element arrives via a prop-ref and direct assignment from component
 * scope trips the react-hooks immutability rule.
 */
export function setScrollTop(container: HTMLElement, value: number): void {
  container.scrollTop = value;
}

/** Where the reading anchor currently is: page plus fraction within it. */
export interface PdfAnchorInfo {
  page: number;
  fraction: number;
}

interface PdfScrollTrackingOptions {
  /** The scrollable reader container (owned by ReaderShell). */
  containerRef: RefObject<HTMLElement | null>;
  /** The document element whose slot tops the layout math describes. */
  documentRef: RefObject<HTMLElement | null>;
  slots: LayoutSlot[];
  enabled: boolean;
  onPageChange: (pageNumber: number) => void;
  /**
   * Receives the anchor's page + in-page fraction on every sample; the
   * reader uses this to preserve the exact reading spot across zoom and
   * resize reflows.
   */
  anchorInfoRef?: RefObject<PdfAnchorInfo | null>;
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
  anchorInfoRef,
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
      if (page === null) return;
      if (anchorInfoRef) {
        const slotTop = offsetForPage(page, slotsRef.current);
        const slot = slotsRef.current.find((candidate) => candidate.pageNumber === page);
        const fraction =
          slot && slotTop !== null && slot.height > 0
            ? Math.max(0, Math.min(1, (anchor - slotTop) / slot.height))
            : 0;
        anchorInfoRef.current = { page, fraction };
      }
      onPageChangeRef.current(page);
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
  }, [anchorInfoRef, containerRef, documentRef, enabled]);
}
