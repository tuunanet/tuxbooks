import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { Book, ReadingProgress } from "@/types/domain";
import { BookContextMenu } from "./BookContextMenu";
import { BookCover } from "./BookCover";

/**
 * Interaction surface shared by the grid card and the list row: single click
 * selects, double click opens the detail view, right click opens the action
 * menu. `tabIndex` is the roving-tabindex value handed out by the grid/list
 * container. `onLocate`/`onRemove` power the missing-file actions.
 */
export interface InteractiveBookProps {
  selected?: boolean;
  progress?: ReadingProgress;
  tabIndex?: number;
  onSelect?: (bookId: number) => void;
  onOpen?: (bookId: number) => void;
  onRead?: (bookId: number) => void;
  onLocate?: (bookId: number) => void;
  onRemove?: (bookId: number) => void;
}

interface BookCardProps extends InteractiveBookProps {
  book: Book;
}

function readingProgressLabel(progress: ReadingProgress): string {
  return `Reading progress: ${progress.percentage}%`;
}

export function BookCard({
  book,
  selected = false,
  progress,
  tabIndex = 0,
  onSelect,
  onOpen,
  onRead,
  onLocate,
  onRemove,
}: BookCardProps) {
  return (
    <div className="relative">
      <BookContextMenu
        book={book}
        onOpen={onOpen}
        onRead={onRead}
        onLocate={onLocate}
        onRemove={onRemove}
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
            onSelect?.(book.id);
          }}
          onDoubleClick={() => onOpen?.(book.id)}
          onContextMenu={() => onSelect?.(book.id)}
          className={cn(
            "group flex flex-col rounded-xl p-1.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
            selected ? "bg-accent/60 ring-2 ring-primary" : "hover:bg-accent/40",
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
            {book.format === "pdf" && (
              <Badge variant="secondary" className="absolute top-1.5 right-1.5">
                PDF
              </Badge>
            )}
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
            {progress && (
              <Progress
                value={progress.percentage}
                aria-label={readingProgressLabel(progress)}
                title={`${progress.percentage}% read`}
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
