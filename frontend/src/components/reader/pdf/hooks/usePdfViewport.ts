import { useEffect, useState, type RefObject } from "react";

/**
 * The scroll container's viewport plus the document element's origin, all in
 * document scroll coordinates. This is the frame the region math intersects
 * pages against (pdfLayout.visiblePageRegion).
 */
export interface PdfViewport {
  scrollTop: number;
  scrollLeft: number;
  width: number;
  height: number;
  /** Document element's top edge in scroll-content coordinates. */
  documentTop: number;
  /** Document element's left edge in scroll-content coordinates. */
  documentLeft: number;
}

const EMPTY: PdfViewport = {
  scrollTop: 0,
  scrollLeft: 0,
  width: 0,
  height: 0,
  documentTop: 0,
  documentLeft: 0,
};

/** Integer-compare so sub-pixel scroll noise never re-renders the reader. */
function sameViewport(a: PdfViewport, b: PdfViewport): boolean {
  return (
    Math.round(a.scrollTop) === Math.round(b.scrollTop) &&
    Math.round(a.scrollLeft) === Math.round(b.scrollLeft) &&
    a.width === b.width &&
    a.height === b.height &&
    Math.round(a.documentTop) === Math.round(b.documentTop) &&
    Math.round(a.documentLeft) === Math.round(b.documentLeft)
  );
}

/**
 * rAF-coalesced viewport sampler for region rendering. Scroll events only
 * schedule one sample per frame; state changes only when the rounded values
 * move, so a smooth scroll drives one region recomputation per frame at most
 * and a still viewport drives none. Mirrors usePdfScrollTracking's sampling
 * discipline, but publishes the raw frame rather than the current page.
 */
export function usePdfViewport(
  containerRef: RefObject<HTMLElement | null>,
  documentRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): PdfViewport {
  const [viewport, setViewport] = useState<PdfViewport>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    const documentEl = documentRef.current;
    if (!container || !documentEl) return;

    let frame = 0;
    const sample = () => {
      frame = 0;
      const containerRect = container.getBoundingClientRect();
      const documentRect = documentEl.getBoundingClientRect();
      const next: PdfViewport = {
        scrollTop: container.scrollTop,
        scrollLeft: container.scrollLeft,
        width: container.clientWidth,
        height: container.clientHeight,
        documentTop: documentRect.top - containerRect.top + container.scrollTop,
        documentLeft: documentRect.left - containerRect.left + container.scrollLeft,
      };
      setViewport((current) => (sameViewport(current, next) ? current : next));
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(sample);
    };

    container.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);
    const observer = new ResizeObserver(request);
    observer.observe(container);
    observer.observe(documentEl);
    request();

    return () => {
      container.removeEventListener("scroll", request);
      window.removeEventListener("resize", request);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [containerRef, documentRef, enabled]);

  return enabled ? viewport : EMPTY;
}
