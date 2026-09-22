import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { computePdfScale, PAPERS_VIEW_SPACING, type PdfScaleRequest } from "../pdfLayout";

/**
 * Layout scale for the continuous reader, derived from the zoom state
 * (issue #65): the fit modes recompute continuously from the measured
 * content area (width) and the shell's scroll container (viewport height),
 * so window resizes and sidebar toggles rescale the document without any
 * stored zoom value going stale; custom mode is a fixed ladder level.
 *
 * Uses the callback-ref + state pattern: the content area mounts only after
 * restoration completes, and a plain ref object would not re-run the effect
 * when it attaches. The scroll container is observed the same way (it
 * exists at mount, but its height changes when chrome appears or the
 * window resizes).
 */
export function usePdfScale(
  request: PdfScaleRequest,
  scrollContainerRef?: RefObject<HTMLElement | null>,
): {
  scale: number;
  contentAreaRef: (element: HTMLDivElement | null) => void;
  /** Measured content-area width, the fit formulas' horizontal input. */
  areaWidth: number;
  /** Measured scroll-viewport height, the fit formulas' vertical input. */
  viewportHeight: number;
} {
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const [areaWidth, setAreaWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const contentAreaRef = useCallback((element: HTMLDivElement | null) => {
    setArea(element);
    setAreaWidth(element?.clientWidth ?? 0);
  }, []);

  // Derived during render, never stored and updated in an effect: a zoom
  // request must yield its new scale in the same commit. A scale that lands
  // one commit late paints the old layout for a frame after the wheel
  // preview transform is dropped, which reads as a jump on every ctrl+wheel
  // commit.
  const scale = useMemo(() => {
    if (!area) return 1;
    return computePdfScale(request, areaWidth, viewportHeight, PAPERS_VIEW_SPACING);
  }, [area, areaWidth, viewportHeight, request]);

  useEffect(() => {
    const container = scrollContainerRef?.current ?? null;
    if (!container) return;
    const update = () => setViewportHeight(container.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [scrollContainerRef]);

  useEffect(() => {
    if (!area) return;

    const update = () => setAreaWidth(area.clientWidth);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(area);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [area]);

  return { scale, contentAreaRef, areaWidth, viewportHeight };
}
