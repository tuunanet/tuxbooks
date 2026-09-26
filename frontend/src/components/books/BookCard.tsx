import type { MouseEvent as ReactMouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { Book, CollectionSummary } from "@/types/domain";
import { BookContextMenu } from "./BookContextMenu";
import { BookCover } from "./BookCover";
import { bookSelectionClass } from "./selection";

/**
 * Interaction surface shared by the grid card and the list row: click
 * selects (Ctrl/Cmd+click toggles, Shift+click takes a range), double click
 * opens the detail view, right click opens the action menu. `onSelect`
 * receives the event so the view can read the modifier keys and tell a
 * right click from a plain one. `tabIndex` is the roving-tabindex value
 * handed out by the grid/list container. `onLocate`/`onRemove` power the
 * missing-file actions; `onAddToCollection`/`onRemoveFromCollection`/
 * `onMarkFinished`/`onReveal` power the milestone-10 menu entries.
 */
export interface InteractiveBookProps {
  selected?: boolean;
  collections: CollectionSummary[];
  tabIndex?: number;
  /** Selection size behind the right-click menu; above one it goes bulk. */
  selectionCount?: number;
  onSelect?: (bookId: number, event: ReactMouseEvent<HTMLElement>) => void;
  onOpen?: (bookId: number) => void;
  onRead?: (bookId: number) => void;
  onLocate?: (bookId: number) => void;
  onEditMetadata?: (bookId: number) => void;
  onRemove?: (bookId: number) => void;
  onAddToCollection?: (bookId: number, collectionId: number) => void;
  onRemoveFromCollection?: (bookId: number, collectionId: number) => void;
  onMarkFinished?: (bookId: number) => void;
  onReveal?: (bookId: number) => void;
  onBulkRemove?: () => void;
  /** Ids in the current selection; the bulk collection submenus read it. */
  selectedBookIds?: number[];
  /** Bulk add: adds every selected book the collection is still missing. */
  onBulkAddToCollection?: (collection: CollectionSummary) => void;
  /** Bulk remove: drops the selected members only. */
  onBulkRemoveFromCollection?: (collection: CollectionSummary) => void;
  onBulkMarkFinished?: () => void;
}

interface BookCardProps extends InteractiveBookProps {
  book: Book;
}

/** The card's progress bar shows the coarse percent from the shared payload. */
function progressPercentOf(book: Book): number | null {
  return book.progressPercent;
}

export function BookCard({
  book,
  selected = false,
  collections,
  tabIndex = 0,
  selectionCount = 1,
  onSelect,
  onOpen,
  onRead,
  onLocate,
  onEditMetadata,
  onRemove,
  onAddToCollection,
  onRemoveFromCollection,
  onMarkFinished,
  onReveal,
  onBulkRemove,
  selectedBookIds,
  onBulkAddToCollection,
  onBulkRemoveFromCollection,
  onBulkMarkFinished,
}: BookCardProps) {
  const percent = progressPercentOf(book);
  return (
    <div className="relative">
      <BookContextMenu
        book={book}
        collections={collections}
        selectionCount={selectionCount}
        onOpen={onOpen}
        onRead={onRead}
        onLocate={onLocate}
        onEditMetadata={onEditMetadata}
        onRemove={onRemove}
        onAddToCollection={onAddToCollection}
        onRemoveFromCollection={onRemoveFromCollection}
        onMarkFinished={onMarkFinished}
        onReveal={onReveal}
        onBulkRemove={onBulkRemove}
        selectedBookIds={selectedBookIds}
        onBulkAddToCollection={onBulkAddToCollection}
        onBulkRemoveFromCollection={onBulkRemoveFromCollection}
        onBulkMarkFinished={onBulkMarkFinished}
      >
        <button
          type="button"
          data-testid="book-card"
          data-book-card=""
          data-book-id={book.id}
          aria-label={`${book.title} (${book.format.toUpperCase()})`}
          aria-pressed={selected}
          tabIndex={tabIndex}
          onClick={(event) => {
            // WebKit does not focus buttons on click; keep keyboard roving consistent.
            event.currentTarget.focus();
            onSelect?.(book.id, event);
          }}
          onDoubleClick={() => onOpen?.(book.id)}
          onContextMenu={(event) => onSelect?.(book.id, event)}
          className={cn(
            "group flex flex-col rounded-xl p-1.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
            bookSelectionClass(selected),
          )}
        >
          <div className="relative">
            <BookCover
              book={book}
              className={cn(
                "aspect-[2/3] w-full text-4xl",
                !book.available && "opacity-40 grayscale",
              )}
            />
            <Badge variant="secondary" className="absolute top-1.5 right-1.5">
              {book.format.toUpperCase()}
            </Badge>
            {!book.available && (
              <Badge variant="destructive" className="absolute top-1.5 left-1.5">
                Missing
              </Badge>
            )}
          </div>
          <div className="px-0.5 pt-2 pb-1">
            <p className="line-clamp-2 min-h-10 text-sm leading-snug font-medium">{book.title}</p>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {book.author ?? "Unknown author"}
            </p>
            {percent !== null && (
              <Progress
                value={percent}
                aria-label={`Reading progress: ${Math.round(percent)}%`}
                title={`${Math.round(percent)}% read`}
                className="mt-2"
              />
            )}
          </div>
        </button>
      </BookContextMenu>
      {!book.available && (
        // Sibling overlay (not nested inside the card button): the file is
        // gone, so the primary actions here are recovery actions.
        <div
          data-testid="book-card-missing"
          className="absolute inset-x-2 top-2 rounded-lg border border-destructive/40 bg-background/95 p-2 shadow-sm"
        >
          <p className="text-center text-xs font-medium text-destructive">File unavailable</p>
          <div className="mt-1.5 flex gap-1">
            <Button
              size="sm"
              className="h-7 flex-1 px-1 text-xs"
              data-testid="missing-locate"
              onClick={() => onLocate?.(book.id)}
            >
              Locate File
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 flex-1 px-1 text-xs"
              data-testid="missing-remove"
              onClick={() => onRemove?.(book.id)}
            >
              Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
