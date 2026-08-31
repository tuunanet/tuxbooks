import { useCallback, useEffect, useRef, useState } from "react";

/** How far ahead of the viewport pages are preloaded, in viewport heights. */
const PRELOAD_ROOT_MARGIN = "100% 0px 100% 0px";

export interface PdfVirtualization {
  /** Callback ref for a page slot element; null on unregistration. */
  registerSlot: (pageNumber: number, element: HTMLDivElement | null) => void;
  /** Pages currently intersecting the viewport. */
  visiblePages: ReadonlySet<number>;
  /** Pages within the preload margin around the viewport. */
  preloadPages: ReadonlySet<number>;
}

/**
 * Visibility tracking for page slots. One observer pair watches the slot
 * elements themselves (never nested internals): the visible observer uses no
 * margin, the preload observer extends the root by one viewport height on
 * each side so approaching pages render just before they scroll in. The
 * observers use the implicit root, so they work regardless of which
 * ancestor element scrolls. State updates coalesce: a callback that does not
 * change either set re-reports the previous state and React skips the render.
 */
export function usePdfVirtualization(): PdfVirtualization {
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(() => new Set());
  const [preloadPages, setPreloadPages] = useState<ReadonlySet<number>>(() => new Set());
  const slotElementsRef = useRef(new Map<number, HTMLDivElement>());
  const slotPagesRef = useRef(new Map<Element, number>());
  const visibleObserverRef = useRef<IntersectionObserver | null>(null);
  const preloadObserverRef = useRef<IntersectionObserver | null>(null);

  const applyEntries = useCallback(
    (observer: IntersectionObserver, entries: IntersectionObserverEntry[]) => {
      const setVisible =
        observer === visibleObserverRef.current
          ? setVisiblePages
          : observer === preloadObserverRef.current
            ? setPreloadPages
            : null;
      if (!setVisible) return;

      setVisible((current) => {
        const next = new Set(current);
        let changed = false;
        for (const entry of entries) {
          const page = slotPagesRef.current.get(entry.target);
          if (page === undefined) continue;
          if (entry.isIntersecting) {
            if (!next.has(page)) {
              next.add(page);
              changed = true;
            }
          } else if (next.has(page)) {
            next.delete(page);
            changed = true;
          }
        }
        return changed ? next : current;
      });
    },
    [],
  );

  useEffect(() => {
    const visible = new IntersectionObserver((entries) => applyEntries(visible, entries), {
      rootMargin: "0px",
    });
    const preload = new IntersectionObserver((entries) => applyEntries(preload, entries), {
      rootMargin: PRELOAD_ROOT_MARGIN,
    });
    visibleObserverRef.current = visible;
    preloadObserverRef.current = preload;

    // Slots can register before this effect runs (callback refs commit
    // first); observe everything already known.
    for (const element of slotElementsRef.current.values()) {
      visible.observe(element);
      preload.observe(element);
    }

    return () => {
      visible.disconnect();
      preload.disconnect();
      visibleObserverRef.current = null;
      preloadObserverRef.current = null;
    };
  }, [applyEntries]);

  const registerSlot = useCallback((pageNumber: number, element: HTMLDivElement | null) => {
    const previous = slotElementsRef.current.get(pageNumber);
    if (previous === element) return;
    if (previous) {
      visibleObserverRef.current?.unobserve(previous);
      preloadObserverRef.current?.unobserve(previous);
      slotPagesRef.current.delete(previous);
    }
    if (element) {
      slotElementsRef.current.set(pageNumber, element);
      slotPagesRef.current.set(element, pageNumber);
      visibleObserverRef.current?.observe(element);
      preloadObserverRef.current?.observe(element);
    } else {
      slotElementsRef.current.delete(pageNumber);
    }
  }, []);

  return { registerSlot, visiblePages, preloadPages };
}
