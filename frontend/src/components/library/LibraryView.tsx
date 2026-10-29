import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBookActions } from "@/hooks/useBookActions";
import { useCollectionActions } from "@/hooks/useCollectionActions";
import { useLibrary } from "@/hooks/useLibrary";
import { revealBook } from "@/lib/bridge";
import { useAppDispatch, useAppState, type LibrarySection } from "@/state/appState";
import { BulkRemoveDialog } from "./BulkRemoveDialog";
import { EmptyLibraryState } from "./EmptyLibraryState";
import { ForgetBookDialog } from "@/components/books/ForgetBookDialog";
import { ResetBookDialog } from "@/components/books/ResetBookDialog";
import { LibraryCard } from "./LibraryCard";
import { LibraryEmptyState } from "./LibraryEmptyState";
import { LibraryHeader } from "./LibraryHeader";
import { LibraryScrollArea } from "./LibraryScrollArea";
import { SelectionBar } from "./SelectionBar";
import {
  isCollectionEmpty,
  libraryTitle,
  selectVisibleBooks,
  type BookSortId,
  type BookViewMode,
} from "./sections";
import { useLibraryBulkActions } from "./useLibraryBulkActions";
import { useLibraryKeyboardNav } from "./useLibraryKeyboardNav";
import { useLibrarySelection } from "./useLibrarySelection";
import { useLibraryVirtualizer } from "./useLibraryVirtualizer";
import type { Book, BookFormat } from "@/types/domain";

interface LibraryViewProps {
  section: LibrarySection;
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
  const bookActions = useBookActions();
  const {
    locateBook,
    removeBookFromLibrary,
    resetReadingData,
    forgetBookFromLibrary,
    markFinished,
  } = bookActions;
  const collectionActions = useCollectionActions();
  const app = useAppState();
  const dispatch = useAppDispatch();
  const [resetTarget, setResetTarget] = useState<Book | null>(null);
  const [forgetTarget, setForgetTarget] = useState<Book | null>(null);

  // View mode and sort are presentation preferences. The search query is app
  // state scoped to the section and cleared when the section changes; the
  // format filter survives because it composes with every section.
  const [view, setView] = useState<BookViewMode>("grid");
  const [sort, setSort] = useState<BookSortId>("recently-added");
  const query = app.libraryQuery;
  const formatFilter = app.formatFilter;

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
  const setFormatFilter = useCallback(
    (formats: BookFormat[]) => dispatch({ type: "set-format-filter", formats }),
    [dispatch],
  );
  const handleReveal = useCallback((bookId: number) => {
    void revealBook(bookId);
  }, []);

  const collectionIsEmpty = isCollectionEmpty(section, collections);

  const visible = useMemo(
    () => selectVisibleBooks({ books, collections, section, formatFilter, sort, query }),
    [books, collections, section, sort, query, formatFilter],
  );

  // Selected ids outlive the filter, so a book a search hides stays selected
  // and is counted by the selection bar.
  const selectedIds = app.selectedBookIds;
  const visibleIds = useMemo(() => visible.map((book) => book.id), [visible]);
  const { selectedSet, clearSelection, selectBook, clearOnBackground } = useLibrarySelection(
    selectedIds,
    visibleIds,
  );

  const bulk = useLibraryBulkActions({
    selectedIds,
    books,
    bookActions,
    collectionActions,
    refresh,
  });

  const {
    attachScroller,
    containerRef,
    saveScroll,
    markScrolling,
    columnCount,
    virtualizer,
    unvirtualized,
    fallbackRowCount,
  } = useLibraryVirtualizer({ visible, view, section });

  const isGrid = view === "grid";
  const { focusedIndex, handleContainerKeyDown, handleFocusCapture } = useLibraryKeyboardNav({
    visible,
    columnCount,
    isGrid,
    openDetail,
    containerRef,
    virtualizer,
  });

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

  const itemPropsFor = (book: Book, index: number) => ({
    book,
    collections,
    selected: selectedSet.has(book.id),
    selectionCount: selectedIds.length,
    tabIndex: index === focusedIndex ? 0 : -1,
    onSelect: selectBook,
    onOpen: openDetail,
    onRead: openReader,
    onLocate: locateBook,
    onEditMetadata: openMetadataEditor,
    onRemove: removeBookFromLibrary,
    onReset: (bookId: number) => {
      const target = books.find((candidate) => candidate.id === bookId);
      if (target) setResetTarget(target);
    },
    onForget: (bookId: number) => {
      const target = books.find((candidate) => candidate.id === bookId);
      if (target) setForgetTarget(target);
    },
    onAddToCollection: collectionActions.addBook,
    onRemoveFromCollection: collectionActions.removeBook,
    onMarkFinished: markFinished,
    onReveal: handleReveal,
    onBulkRemove: () => bulk.setBulkRemoveOpen(true),
    selectedBookIds: selectedIds,
    onBulkAddToCollection: bulk.bulkAddToCollection,
    onBulkRemoveFromCollection: bulk.bulkRemoveFromCollection,
    onBulkMarkFinished: bulk.bulkMarkFinished,
  });

  const renderCard = (book: Book, index: number) => (
    <LibraryCard key={book.id} index={index} isGrid={isGrid} {...itemPropsFor(book, index)} />
  );

  return (
    <section
      data-testid="library-view"
      className="flex h-full min-h-0 flex-col"
      onClick={clearOnBackground}
      onContextMenu={clearOnBackground}
    >
      <LibraryHeader
        title={libraryTitle(section, collections)}
        count={visible.length}
        query={query}
        onQueryChange={setQuery}
        formats={formatFilter}
        onFormatsChange={setFormatFilter}
        sort={sort}
        onSortChange={setSort}
        view={view}
        onViewChange={setView}
      />
      <SelectionBar
        count={selectedIds.length}
        message={bulk.bulkMessage}
        onClear={clearSelection}
      />
      <BulkRemoveDialog
        open={bulk.bulkRemoveOpen}
        count={selectedIds.length}
        onConfirm={() => void bulk.confirmBulkRemove()}
        onCancel={() => bulk.setBulkRemoveOpen(false)}
      />
      <ResetBookDialog
        open={resetTarget !== null}
        title={resetTarget?.title}
        onConfirm={() => {
          const target = resetTarget;
          setResetTarget(null);
          if (target) void resetReadingData(target.id);
        }}
        onCancel={() => setResetTarget(null)}
      />
      <ForgetBookDialog
        open={forgetTarget !== null}
        count={1}
        keepsFile
        onConfirm={() => {
          const target = forgetTarget;
          setForgetTarget(null);
          if (target) void forgetBookFromLibrary(target.id);
        }}
        onCancel={() => setForgetTarget(null)}
      />
      {visible.length === 0 ? (
        <LibraryEmptyState
          query={query}
          formats={formatFilter}
          collectionIsEmpty={collectionIsEmpty}
          onClearSearch={() => setQuery("")}
          onClearFormats={() => setFormatFilter([])}
        />
      ) : (
        <LibraryScrollArea
          visible={visible}
          isGrid={isGrid}
          columnCount={columnCount}
          fallbackRowCount={fallbackRowCount}
          unvirtualized={unvirtualized}
          virtualizer={virtualizer}
          attachScroller={attachScroller}
          onKeyDown={handleContainerKeyDown}
          onFocusCapture={handleFocusCapture}
          onScroll={() => {
            saveScroll();
            markScrolling();
          }}
          renderCard={renderCard}
        />
      )}
    </section>
  );
}
