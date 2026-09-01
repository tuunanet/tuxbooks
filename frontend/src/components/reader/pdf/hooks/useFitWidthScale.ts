import { useCallback, useEffect, useState } from "react";
import { fitWidthScale } from "../pdfLayout";

/**
 * Layout scale that fits the reference page (page 1) into the reader's
 * content area. Recomputes when the area resizes; returns 1 whenever the
 * area cannot be measured so callers never render at a zero scale.
 *
 * Uses the callback-ref + state pattern: the content area mounts only after
 * restoration completes, and a plain ref object would not re-run the effect
 * when it attaches.
 */
export function useFitWidthScale(referencePageWidth: number): {
  scale: number;
  contentAreaRef: (element: HTMLDivElement | null) => void;
} {
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  const contentAreaRef = useCallback((element: HTMLDivElement | null) => {
    setArea(element);
  }, []);

  useEffect(() => {
    if (!area || referencePageWidth <= 0) return;

    const update = () => {
      const available = area.clientWidth;
      if (available > 0) setScale(fitWidthScale(available, referencePageWidth));
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(area);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [area, referencePageWidth]);

  return { scale, contentAreaRef };
}
