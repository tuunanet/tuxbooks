import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { BookCard } from "@/components/books/BookCard";
import { BookListItem } from "@/components/books/BookListItem";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBookActions } from "@/hooks/useBookActions";
import { useCollectionActions } from "@/hooks/useCollectionActions";
import { useLibrary } from "@/hooks/useLibrary";
import { revealInFileManager } from "@/lib/tauri";
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

interface LibraryViewProps {
  section: LibrarySection;
}

function columnCount(container: HTMLElement): number {
  // Falls back to a single column when the computed template is unavailable
  // (jsdom tests, display:none), which keeps Up/Down roving correct.
  const template = getComputedStyle(container).gridTemplateColumns;
  const count = template.split(" ").filter(Boolean).length;
  return count > 0 ? count : 1;
}

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
    (bookId: number) => dispatch({ type: "open-metadata-editor", bookId }),
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
  const handleReveal = useCallback(
    (bookId: number) => {
      const target = books.find((book) => book.id === bookId);
      if (target) void revealInFileManager(target.path);
    },
    [books],
  );

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

  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Grid/list widget keys: arrows + Home/End rove focus between card buttons,
   * Enter opens the focused card's detail. These are widget-level bindings,
   * not app shortcuts, so they live on the container instead of the global
   * shortcut registry (which would hijack Enter elsewhere on the page).
   */
  const handleContainerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-book-card]"));
      const active = document.activeElement;

      if (event.key === "Enter") {
        const card =
          active instanceof HTMLElement ? active.closest<HTMLElement>("[data-book-card]") : null;
        if (card?.dataset.bookId) {
          event.preventDefault();
          openDetail(Number(card.dataset.bookId));
        }
        return;
      }

      const index = cards.findIndex((card) => card === active);
      if (index === -1) return;

      let next: number;
      switch (event.key) {
        case "ArrowRight":
          next = index + 1;
          break;
        case "ArrowLeft":
          next = index - 1;
          break;
        case "ArrowDown":
          next = index + columnCount(container);
          break;
        case "ArrowUp":
          next = index - columnCount(container);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = cards.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      cards[Math.min(Math.max(next, 0), cards.length - 1)]?.focus();
    },
    [openDetail],
  );

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

  const selectedId = app.selectedBookId;
  const rovingIndex = visible.findIndex((book) => book.id === selectedId);
  const defaultFocusIndex = rovingIndex === -1 ? 0 : rovingIndex;

  const renderItem = (book: (typeof visible)[number], index: number) => {
    const itemProps = {
      book,
      collections,
      selected: book.id === selectedId,
      tabIndex: index === defaultFocusIndex ? 0 : -1,
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
    return view === "grid" ? (
      <BookCard key={book.id} {...itemProps} />
    ) : (
      <BookListItem key={book.id} {...itemProps} />
    );
  };

  return (
    <section data-testid="library-view">
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
          ref={containerRef}
          data-testid={view === "grid" ? "book-grid" : "book-list"}
          onKeyDown={handleContainerKeyDown}
          className={
            view === "grid"
              ? "grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4"
              : "flex flex-col gap-1"
          }
        >
          {visible.map(renderItem)}
        </div>
      )}
    </section>
  );
}
