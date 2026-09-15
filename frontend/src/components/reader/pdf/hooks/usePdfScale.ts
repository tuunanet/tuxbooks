import { useCallback, useEffect, useState, type RefObject } from "react";
import { computePdfScale, type PdfScaleRequest } from "../pdfLayout";

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
} {
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scale, setScale] = useState(1);

  const contentAreaRef = useCallback((element: HTMLDivElement | null) => {
    setArea(element);
  }, []);

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

    const update = () => {
      setScale(computePdfScale(request, area.clientWidth, viewportHeight));
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(area);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
    // The request object is rebuilt per render by the caller; only its
    // fields drive the scale, so they are the real dependencies.
  }, [area, viewportHeight, request]);

  return { scale, contentAreaRef };
}
