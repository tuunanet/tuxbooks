import { useCallback, useState } from "react";
import { useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual";

/**
 * Windowed rendering for the Reading history list (PERF-18): the DOM row
 * count is the visible slice plus overscan, never one node per book. A slim
 * single-column sibling of the library virtualizer
 * (components/library/useLibraryVirtualizer.ts): no grid columns, no scroll
 * persistence, no scroll-in-flight measure deferral — history rows are
 * near-uniform, so the plain estimate-then-measure flow holds the scrollbar
 * steady.
 */

/** Row estimate: p-3 card with an h-20 cover plus the pb-2 window gap. */
const ROW_ESTIMATE_PX = 114;
const OVERSCAN_ROWS = 5;

/**
 * No-layout environments (jsdom tests, SSR) produce no virtual rows; the
 * view then renders this many rows statically instead of nothing. Bounded,
 * because the grace path must never become the shipped rendering.
 */
const FALLBACK_ROWS = 60;

export interface HistoryVirtualizer {
  attachScroller: (el: HTMLDivElement | null) => void;
  virtualizer: ReactVirtualizer<HTMLDivElement, Element>;
  virtualRows: ReturnType<ReactVirtualizer<HTMLDivElement, Element>["getVirtualItems"]>;
  unvirtualized: boolean;
  fallbackRowCount: number;
}

export function useHistoryVirtualizer(
  count: number,
  getItemKey: (index: number) => string,
): HistoryVirtualizer {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const attachScroller = useCallback((el: HTMLDivElement | null) => setScrollEl(el), []);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollEl,
    // tanstack's default flushSync-on-notify fires from layout effects while
    // React is rendering; async commits keep window shifts on the normal
    // scheduler (mirrors the library virtualizer).
    useFlushSync: false,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: OVERSCAN_ROWS,
    // No-layout environments report offsetHeight 0 for every row; taking
    // that at face value collapses the whole list into the viewport and
    // re-renders forever. Keep the estimate there; real renders report true
    // heights and are measured.
    measureElement: (node, entry, instance) => {
      const entrySize = entry?.borderBoxSize?.at(0)?.blockSize;
      const size = typeof entrySize === "number" ? entrySize : (node as HTMLElement).offsetHeight;
      return size > 0 ? size : instance.options.estimateSize(instance.indexFromElement(node));
    },
    getItemKey,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const unvirtualized = virtualRows.length === 0 && count > 0;

  return {
    attachScroller,
    virtualizer,
    virtualRows,
    unvirtualized,
    fallbackRowCount: Math.min(count, FALLBACK_ROWS),
  };
}
