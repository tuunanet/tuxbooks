import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { ReactVirtualizer } from "@tanstack/react-virtual";
import type { Book } from "@/types/domain";

/** Arrow keys move by one card or one row; Home/End jump to the ends. */
const KEY_MOVES: Record<string, (index: number, columns: number, length: number) => number> = {
  ArrowRight: (index) => index + 1,
  ArrowLeft: (index) => index - 1,
  ArrowDown: (index, columns) => index + columns,
  ArrowUp: (index, columns) => index - columns,
  Home: () => 0,
  End: (_index, _columns, length) => length - 1,
};

/** The next focus index, clamped to the visible range. */
function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length - 1);
}

interface UseLibraryKeyboardNavInput {
  visible: Book[];
  columnCount: number;
  isGrid: boolean;
  openDetail: (bookId: number) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  virtualizer: ReactVirtualizer<HTMLDivElement, Element>;
}

/**
 * Roving focus over the virtualized grid: the focus is an index into
 * `visible`, not a DOM query, because most cards do not exist while
 * virtualized. A target row that has not rendered yet is scrolled into view,
 * then a short rAF loop focuses the card once it materializes.
 */ export function useLibraryKeyboardNav({
  visible,
  columnCount,
  isGrid,
  openDetail,
  containerRef,
  virtualizer,
}: UseLibraryKeyboardNavInput) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const pendingFocusRef = useRef(false);

  const focusCardAt = useCallback(
    (index: number): HTMLElement | null =>
      containerRef.current?.querySelector<HTMLElement>(
        `[data-card-index="${index}"] [data-book-card]`,
      ) ?? null,
    [containerRef],
  );

  useEffect(() => {
    if (!pendingFocusRef.current) return;
    let frames = 0;
    let raf = 0;
    const tick = () => {
      const el = focusCardAt(focusedIndex);
      if (el) {
        el.focus({ preventScroll: true });
        pendingFocusRef.current = false;
        return;
      }
      frames += 1;
      if (frames < 10) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [focusedIndex, focusCardAt]);

  const handleContainerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === "Enter") {
        const book = visible[focusedIndex];
        if (book) {
          event.preventDefault();
          openDetail(book.id);
        }
        return;
      }
      const move = KEY_MOVES[event.key];
      if (!move) return;
      // The old switch prevented default for its keys even on an empty
      // section, so keep the page from scrolling there too.
      event.preventDefault();
      if (visible.length === 0) return;
      const nextIndex = clampIndex(move(focusedIndex, columnCount, visible.length), visible.length);
      setFocusedIndex(nextIndex);
      const el = focusCardAt(nextIndex);
      if (el) {
        el.focus({ preventScroll: true });
        return;
      }
      pendingFocusRef.current = true;
      virtualizer.scrollToIndex(isGrid ? Math.floor(nextIndex / columnCount) : nextIndex, {
        align: "auto",
      });
    },
    [focusedIndex, visible, columnCount, isGrid, openDetail, focusCardAt, virtualizer],
  );

  // Click- and program-focus on a card syncs the roving index (focus does
  // not bubble, hence the capture).
  const handleFocusCapture = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-card-index]");
    const index = Number(cell?.dataset.cardIndex);
    if (Number.isFinite(index)) setFocusedIndex(index);
  }, []);

  return { focusedIndex, handleContainerKeyDown, handleFocusCapture };
}
