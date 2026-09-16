import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BookCard } from "@/components/books/BookCard";
import { BookListItem } from "@/components/books/BookListItem";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBookActions } from "@/hooks/useBookActions";
import { useCollectionActions } from "@/hooks/useCollectionActions";
import { useLibrary } from "@/hooks/useLibrary";
import { revealBook } from "@/lib/bridge";
import { useAppDispatch, useAppState, type LibrarySection } from "@/state/appState";
import { EmptyCollectionState } from "./EmptyCollectionState";
import { EmptyLibraryState } from "./EmptyLibraryState";
import { LibraryHeader } from "./LibraryHeader";
import { NoSearchResultsState } from "./NoSearchResultsState";
import {
  filterBooksByCollection,
  filterBooksByQuery,
  filterBooksBySection,
  sectionTitle,
  sortBooks,
  type BookSortId,
  type BookViewMode,
} from "./sections";
import type { Book } from "@/types/domain";

interface LibraryViewProps {
  section: LibrarySection;
}

/**
 * Grid metrics for the virtualizer — they must mirror the row template
 * below (`repeat(N, minmax(0, 1fr))` with `gap-4`). The column count is
 * computed from the measured container width instead of CSS auto-fill so
 * the row ranges and keyboard navigation agree with what is rendered.
 */
const GRID_MIN_CARD_PX = 160;
const GRID_GAP_PX = 16;
/** Cover (1.5 × card width) + text block, before measurement corrects it. */
const GRID_TEXT_ESTIMATE_PX = 80;
/** One BookListItem row plus its gap, before measurement corrects it. */
const LIST_ROW_ESTIMATE_PX = 76;
const OVERSCAN_ROWS = 2;

/**
 * Scroll positions per section, surviving detail/reader round trips
 * (module-level: the view unmounts on navigation).
 */
const scrollPositions = new Map<string, number>();

/** Skeleton grid shown while the shared library payload is loading. */
function LibrarySkeleton() {
  return (
    <div
      data-testid="library-loading"
      aria-label="Loading library"
      role="status"
      className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="aspect-[2/3] w-full rounded-xl" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function LibraryView({ section }: LibraryViewProps) {
  const { books, collections, loading, error, refresh } = useLibrary();
  const { locateBook, removeBookFromLibrary, markFinished } = useBookActions();
  const collectionActions = useCollectionActions();
  const app = useAppState();
  const dispatch = useAppDispatch();

  // View mode and sort are presentation preferences; the search query is
  // section-scoped app state so it resets when the sidebar section changes.
  const [view, setView] = useState<BookViewMode>("grid");
  const [sort, setSort] = useState<BookSortId>("recently-added");
  const query = app.libraryQuery;

  const selectBook = useCallback(
    (bookId: number | null) => dispatch({ type: "select-book", bookId }),
    [dispatch],
  );
  const openDetail = useCallback(
    (bookId: number) => dispatch({ type: "open-book-detail", bookId }),
    [dispatch],
  );
  const openMetadataEditor = useCallback(
    (bookId: number) => dispatch({ type: "open-book-detail", bookId, tab: "metadata" }),
    [dispatch],
  );
  const openReader = useCallback(
    (bookId: number) => {
      // A missing file cannot be read; the recovery entry points live on
      // the card and detail view instead.
      if (books.find((book) => book.id === bookId)?.available === false) return;
      dispatch({ type: "open-reader", bookId });
    },
    [books, dispatch],
  );
  const setQuery = useCallback(
    (next: string) => dispatch({ type: "set-library-query", query: next }),
    [dispatch],
  );
  const handleReveal = useCallback((bookId: number) => {
    void revealBook(bookId);
  }, []);

  const visible = useMemo(() => {
    let scoped =
      section.kind === "collection"
        ? filterBooksByCollection(
            books,
            collections.find((collection) => collection.id === section.id)?.bookIds ?? [],
          )
        : filterBooksBySection(books, section);
    scoped = sortBooks(scoped, sort);
    return filterBooksByQuery(scoped, query);
  }, [books, collections, section, sort, query]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  /**
   * The virtualized window. Attached through a callback ref so the
   * measurement starts whenever the scroller mounts (the empty/loading
   * branches render without it) — jsdom's zero-width fallback keeps one
   * column, matching the no-layout test environment.
   */
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    // `scrollRef.current` is nulled by React on detach — before layout
    // cleanups run — so the scroll-save path reads this handle instead.
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

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollEl,
    // tanstack's default flushSync-on-notify fires from layout effects
    // while React is rendering ("React cannot flush when React is already
    // rendering"); async commits keep the window shift on the normal
    // scheduler, which is imperceptible for scrolling.
    useFlushSync: false,
    estimateSize: () => rowEstimate,
    overscan: OVERSCAN_ROWS,
    // No-layout environments (jsdom tests, SSR) report offsetHeight 0 for
    // every row; taking that at face value collapses the whole list into
    // the viewport (every row "fits") and re-renders forever. Keep the
    // estimate there — real renders report true heights and are measured.
    measureElement: (node, entry, instance) => {
      const entrySize = entry?.borderBoxSize?.at(0)?.blockSize;
      const size = typeof entrySize === "number" ? entrySize : (node as HTMLElement).offsetHeight;
      return size > 0 ? size : instance.options.estimateSize(instance.indexFromElement(node));
    },
    getItemKey: (rowIndex) => {
      const first = isGrid ? visible[rowIndex * columnCount] : visible[rowIndex];
      return first ? `book-${first.id}` : `row-${rowIndex}`;
    },
  });

  // Keyboard roving: the focus is an index into `visible`, not a DOM
  // query — most cards do not exist while virtualized. The element is
  // focused synchronously when the target row is rendered; otherwise the
  // virtualizer scrolls it into view and a short rAF loop focuses the
  // card once it materializes.
  const [focusedIndex, setFocusedIndex] = useState(0);
  const pendingFocusRef = useRef(false);

  // The scroller doubles as the keyboard-navigation container.
  const containerRef = scrollRef;
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
      let next: number;
      switch (event.key) {
        case "ArrowRight":
          next = focusedIndex + 1;
          break;
        case "ArrowLeft":
          next = focusedIndex - 1;
          break;
        case "ArrowDown":
          next = focusedIndex + columnCount;
          break;
        case "ArrowUp":
          next = focusedIndex - columnCount;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = visible.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      if (visible.length === 0) return;
      next = Math.min(Math.max(next, 0), visible.length - 1);
      setFocusedIndex(next);
      const el = focusCardAt(next);
      if (el) {
        el.focus({ preventScroll: true });
        return;
      }
      pendingFocusRef.current = true;
      virtualizer.scrollToIndex(isGrid ? Math.floor(next / columnCount) : next, {
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

  // Scroll position survives navigation: saved continuously on scroll
  // (plus on section change/unmount) and restored on mount. The save must
  // not read `scrollRef.current` at unmount time — React detaches refs
  // (callback refs get null) before layout cleanups run, which silently
  // dropped every save; `scrollElRef` is never nulled and the onScroll
  // write keeps the map current regardless of teardown order.
  const sectionKey = `${section.kind}:${"id" in section ? section.id : ""}`;
  const scrollElRef = useRef<HTMLDivElement | null>(null);
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

  if (loading) {
    return <LibrarySkeleton />;
  }

  if (error) {
    return (
      <div
        data-testid="error-banner"
        role="alert"
        className="rounded-md border border-destructive/50 bg-destructive/10 p-4"
      >
        <p className="font-medium">Failed to load the library</p>
        <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  if (books.length === 0 && section.kind === "smart" && section.id === "all-books") {
    return <EmptyLibraryState />;
  }

  const renderCard = (book: Book, index: number) => {
    const itemProps = {
      book,
      collections,
      selected: book.id === app.selectedBookId,
      tabIndex: index === focusedIndex ? 0 : -1,
      onSelect: selectBook,
      onOpen: openDetail,
      onRead: openReader,
      onLocate: locateBook,
      onEditMetadata: openMetadataEditor,
      onRemove: removeBookFromLibrary,
      onAddToCollection: collectionActions.addBook,
      onRemoveFromCollection: collectionActions.removeBook,
      onMarkFinished: markFinished,
      onReveal: handleReveal,
    };
    const content = view === "grid" ? <BookCard {...itemProps} /> : <BookListItem {...itemProps} />;
    // `display: contents` keeps the wrapper invisible to the row grid/list
    // layout while carrying the index for the focus model.
    return (
      <div key={book.id} data-card-index={index} className="contents">
        {content}
      </div>
    );
  };

  const virtualRows = virtualizer.getVirtualItems();
  /**
   * No geometry yet (jsdom without stubs, SSR): the virtualizer's window
   * is empty, so render rows statically instead of nothing — bounded,
   * because this path is a grace mode, never the shipped rendering (the
   * packaged app always has a real viewport and goes through the
   * virtualizer).
   */
  const FALLBACK_ROWS = 60;
  const unvirtualized = virtualRows.length === 0 && rowCount > 0;
  const fallbackRowCount = Math.min(rowCount, FALLBACK_ROWS);

  const renderRow = (
    rowIndex: number,
    absolute?: { start: number; key: string | number; measure: (node: Element | null) => void },
  ) => {
    const start = rowIndex * columnCount;
    const rowBooks = isGrid
      ? visible.slice(start, start + columnCount)
      : visible.slice(rowIndex, rowIndex + 1);
    const body = isGrid ? (
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
      >
        {rowBooks.map((book, offset) => renderCard(book, start + offset))}
      </div>
    ) : (
      <div className="pb-1">
        {rowBooks.map((book, offset) => renderCard(book, rowIndex + offset))}
      </div>
    );
    if (!absolute) return <div key={rowIndex}>{body}</div>;
    return (
      <div
        key={absolute.key}
        data-index={rowIndex}
        ref={absolute.measure}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          transform: `translateY(${absolute.start}px)`,
        }}
      >
        {body}
      </div>
    );
  };

  return (
    <section data-testid="library-view" className="flex h-full min-h-0 flex-col">
      <LibraryHeader
        title={
          section.kind === "collection"
            ? (collections.find((collection) => collection.id === section.id)?.name ?? "Collection")
            : sectionTitle(section)
        }
        count={visible.length}
        query={query}
        onQueryChange={setQuery}
        sort={sort}
        onSortChange={setSort}
        view={view}
        onViewChange={setView}
      />
      {visible.length === 0 ? (
        query.trim() !== "" ? (
          <NoSearchResultsState query={query} onClearSearch={() => setQuery("")} />
        ) : section.kind === "collection" ? (
          <EmptyCollectionState />
        ) : (
          <p data-testid="empty-section" className="text-sm text-muted-foreground">
            No books in this view yet.
          </p>
        )
      ) : (
        <div
          ref={attachScroller}
          data-testid={isGrid ? "book-grid" : "book-list"}
          onKeyDown={handleContainerKeyDown}
          onFocusCapture={handleFocusCapture}
          onScroll={() => {
            const el = scrollElRef.current;
            if (el) scrollPositions.set(sectionKeyRef.current, el.scrollTop);
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {unvirtualized ? (
            <div>
              {Array.from({ length: fallbackRowCount }, (_, rowIndex) => renderRow(rowIndex))}
            </div>
          ) : (
            <div
              style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
            >
              {virtualRows.map((virtualRow) =>
                renderRow(virtualRow.index, {
                  start: virtualRow.start,
                  key: virtualRow.key as string | number,
                  measure: virtualizer.measureElement,
                }),
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
