import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual";
import type { LibrarySection } from "@/state/appState";
import type { Book } from "@/types/domain";
import type { BookViewMode } from "./sections";

/**
 * Grid metrics for the virtualizer. They must mirror the row template in
 * `LibraryRow` (`repeat(N, minmax(0, 1fr))` with `gap-4`). The column count is
 * computed from the measured container width instead of CSS auto-fill so the
 * row ranges and keyboard navigation agree with what is rendered.
 */
const GRID_MIN_CARD_PX = 160;
const GRID_GAP_PX = 16;
/** Cover (1.5 × card width) + text block, before measurement corrects it. */
const GRID_TEXT_ESTIMATE_PX = 80;
/** One BookListItem row plus its gap, before measurement corrects it. */
const LIST_ROW_ESTIMATE_PX = 76;
const OVERSCAN_ROWS = 2;
/** Idle time after the last scroll event before deferred measurements flush. */
const IS_SCROLL_IDLE_FLUSH_MS = 200;
/**
 * Learned-estimate tuning: EMA weight of each new measurement, and the
 * measured/estimate bounds outside which a reading is treated as pathological
 * and ignored (one bad row must not price the suffix).
 */
const ESTIMATE_RATIO_SMOOTHING = 0.25;
const ESTIMATE_RATIO_MIN = 0.25;
const ESTIMATE_RATIO_MAX = 4;

/**
 * Scroll positions per section, surviving detail/reader round trips
 * (module-level: the view unmounts on navigation).
 */
const scrollPositions = new Map<string, number>();

interface UseLibraryVirtualizerInput {
  visible: Book[];
  view: BookViewMode;
  section: LibrarySection;
}

export interface LibraryVirtualizer {
  attachScroller: (el: HTMLDivElement | null) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  saveScroll: () => void;
  markScrolling: () => void;
  columnCount: number;
  virtualizer: ReactVirtualizer<HTMLDivElement, Element>;
  /** No geometry yet (jsdom, SSR): the bounded non-virtual fallback is in use. */
  unvirtualized: boolean;
  fallbackRowCount: number;
}

/**
 * Owns the scroll container, its width measurement, and the virtualizer:
 * row geometry, the deferred measurement window, and per-section scroll
 * restoration. Keeping it out of `LibraryView` leaves the view to compose.
 */
export function useLibraryVirtualizer({
  visible,
  view,
  section,
}: UseLibraryVirtualizerInput): LibraryVirtualizer {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  /**
   * The virtualized window. Attached through a callback ref so the
   * measurement starts whenever the scroller mounts (the empty/loading
   * branches render without it). jsdom's zero-width fallback keeps one
   * column, matching the no-layout test environment.
   */
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    // `scrollRef.current` is nulled by React on detach, before layout
    // cleanups run, so the scroll-save path reads this handle instead.
    scrollElRef.current = el;
    setScrollEl(el);
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (el) {
      setContainerWidth(el.clientWidth);
      const observer = new ResizeObserver((entries) => {
        const width = entries[entries.length - 1]?.contentRect.width;
        if (width !== undefined) setContainerWidth(width);
      });
      observer.observe(el);
      observerRef.current = observer;
    }
  }, []);

  const isGrid = view === "grid";
  const columnCount = Math.max(
    1,
    Math.floor((containerWidth + GRID_GAP_PX) / (GRID_MIN_CARD_PX + GRID_GAP_PX)),
  );
  const rowCount = isGrid ? Math.ceil(visible.length / columnCount) : visible.length;
  const cardWidth = Math.max(
    GRID_MIN_CARD_PX,
    Math.floor((containerWidth - (columnCount - 1) * GRID_GAP_PX) / columnCount),
  );
  const rowEstimate = isGrid
    ? Math.round(cardWidth * 1.5 + GRID_TEXT_ESTIMATE_PX + GRID_GAP_PX)
    : LIST_ROW_ESTIMATE_PX;

  /**
   * Learned estimate ratio: measured row height over the static estimate,
   * EMA-smoothed across measurements. The static estimate is a guess before
   * the first rows render; with it left as-is, every measurement corrects
   * one row while ~1100 unmeasured rows keep the stale guess, and the
   * scrollbar geometry (total size) keeps moving under a held thumb drag —
   * on a 10k library the thumb visibly walks away from the cursor
   * (tuxbooks-y9s). estimateSize is re-read for every unmeasured row on
   * each measurement, so the ratio re-prices the whole unmeasured suffix
   * after the first few rows land and total size settles almost
   * immediately.
   */
  const measuredRatioRef = useRef(1);
  useEffect(() => {
    // The ratio is relative to the base estimate; a new base (view switch,
    // column-count change) invalidates it.
    measuredRatioRef.current = 1;
  }, [rowEstimate]);

  /**
   * Deferred measurements: while the view is actively scrolling, a real row
   * height landing in the virtualizer rewrites the total size, and that
   * breaks Chromium's in-flight native scrollbar drag (the thumb lags the
   * cursor, then stops following entirely on a 10k library; tuxbooks-y9s).
   * So while scrolling, `measureElement` reports the row's last reported
   * size (delta 0, total size frozen) and queues the node; 200 ms after the
   * last scroll event the queued nodes re-measure and the corrections land
   * against a still thumb. A thumb held still past the idle window flushes
   * mid-hold; the learned ratio keeps those corrections near zero on net,
   * so the geometry shift is sub-pixel.
   */
  const deferredMeasurementsRef = useRef(new Map<string, Element>());
  const flushTimerRef = useRef<number | null>(null);
  const scrollingRef = useRef(false);
  const lastReportedSizesRef = useRef(new Map<string, number>());
  const virtualizerRef = useRef<ReactVirtualizer<HTMLDivElement, Element> | null>(null);

  const flushDeferredMeasurements = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const nodes = [...deferredMeasurementsRef.current.values()];
    deferredMeasurementsRef.current.clear();
    const instance = virtualizerRef.current;
    if (!instance || nodes.length === 0) return;
    for (const node of nodes) instance.measureElement(node);
  }, []);

  // Arm/refresh the scrolling window on every scroll event; the flush runs
  // when the scroll has been idle for IS_SCROLL_IDLE_FLUSH_MS.
  const markScrolling = useCallback(() => {
    scrollingRef.current = true;
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      scrollingRef.current = false;
      flushDeferredMeasurements();
    }, IS_SCROLL_IDLE_FLUSH_MS);
  }, [flushDeferredMeasurements]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    };
  }, []);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollEl,
    // tanstack's default flushSync-on-notify fires from layout effects
    // while React is rendering ("React cannot flush when React is already
    // rendering"); async commits keep the window shift on the normal
    // scheduler, which is imperceptible for scrolling.
    useFlushSync: false,
    estimateSize: () => Math.round(rowEstimate * measuredRatioRef.current),
    // estimateSize/measureElement run inside TanStack's internals (render
    // for the former, ResizeObserver and the idle-flush timer for the
    // latter), not in this component's render. The refs they read are
    // written only from event/timer contexts, and a stale read is
    // self-correcting (estimates are re-priced on the next measurement),
    // so the React Compiler render-phase-ref rule's hazard does not apply.
    overscan: OVERSCAN_ROWS,
    // No-layout environments (jsdom tests, SSR) report offsetHeight 0 for
    // every row; taking that at face value collapses the whole list into
    // the viewport (every row "fits") and re-renders forever. Keep the
    // estimate there; real renders report true heights and are measured.
    measureElement: (node, entry, instance) => {
      const entrySize = entry?.borderBoxSize?.at(0)?.blockSize;
      const size = typeof entrySize === "number" ? entrySize : (node as HTMLElement).offsetHeight;
      const index = instance.indexFromElement(node);
      const key = String(instance.options.getItemKey(index));
      if (size <= 0)
        return lastReportedSizesRef.current.get(key) ?? instance.options.estimateSize(index);
      if (scrollingRef.current) {
        // Scroll in flight: defer. Reporting the row's LAST reported size
        // (or, for a first measurement, the estimate) keeps this row's
        // contribution to the total size, and the scrollbar geometry,
        // frozen for the duration.
        deferredMeasurementsRef.current.set(key, node);
        return lastReportedSizesRef.current.get(key) ?? instance.options.estimateSize(index);
      }
      lastReportedSizesRef.current.set(key, size);
      if (rowEstimate > 0) {
        const ratio = size / rowEstimate;
        if (ratio > ESTIMATE_RATIO_MIN && ratio < ESTIMATE_RATIO_MAX) {
          measuredRatioRef.current =
            measuredRatioRef.current * (1 - ESTIMATE_RATIO_SMOOTHING) +
            ratio * ESTIMATE_RATIO_SMOOTHING;
        }
      }
      return size;
    },
    getItemKey: (rowIndex) => {
      const first = isGrid ? visible[rowIndex * columnCount] : visible[rowIndex];
      return first ? `book-${first.id}` : `row-${rowIndex}`;
    },
  });
  // The instance mirror for the idle-flush timer (which fires outside
  // render) is assigned in an effect, not the component body: refs may not
  // be written during render.
  useEffect(() => {
    virtualizerRef.current = virtualizer;
  }, [virtualizer]);

  // Scroll position survives navigation: saved continuously on scroll
  // (plus on section change/unmount) and restored on mount. The save must
  // not read `scrollRef.current` at unmount time: React detaches refs
  // (callback refs get null) before layout cleanups run, which silently
  // dropped every save; `scrollElRef` is never nulled and the onScroll
  // write keeps the map current regardless of teardown order.
  const sectionKey = `${section.kind}:${"id" in section ? section.id : ""}`;
  const sectionKeyRef = useRef(sectionKey);
  sectionKeyRef.current = sectionKey;
  useLayoutEffect(() => {
    return () => {
      const el = scrollElRef.current;
      if (el) scrollPositions.set(sectionKeyRef.current, el.scrollTop);
    };
  }, []);
  useLayoutEffect(() => {
    if (!scrollEl) return;
    const saved = scrollPositions.get(sectionKey);
    if (saved !== undefined) {
      scrollEl.scrollTop = saved;
      // jsdom does not fire scroll on programmatic sets; the virtualizer
      // needs the event to pick the offset up.
      scrollEl.dispatchEvent(new Event("scroll"));
    }
  }, [scrollEl, sectionKey]);

  /** Keep the section's position current while the user scrolls. */
  const saveScroll = useCallback(() => {
    const el = scrollElRef.current;
    if (el) scrollPositions.set(sectionKeyRef.current, el.scrollTop);
  }, []);

  /**
   * No geometry yet (jsdom without stubs, SSR): the virtualizer's window
   * is empty, so render rows statically instead of nothing. Bounded,
   * because this path is a grace mode, never the shipped rendering (the
   * packaged app always has a real viewport and goes through the
   * virtualizer).
   */
  const FALLBACK_ROWS = 60;
  const virtualRows = virtualizer.getVirtualItems();
  const unvirtualized = virtualRows.length === 0 && rowCount > 0;

  return {
    attachScroller,
    containerRef: scrollRef,
    saveScroll,
    markScrolling,
    columnCount,
    virtualizer,
    unvirtualized,
    fallbackRowCount: Math.min(rowCount, FALLBACK_ROWS),
  };
}
