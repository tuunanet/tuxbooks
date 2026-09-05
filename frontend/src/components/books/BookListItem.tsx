import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { Book } from "@/types/domain";
import type { InteractiveBookProps } from "./BookCard";
import { BookContextMenu } from "./BookContextMenu";
import { BookCover } from "./BookCover";

interface BookListItemProps extends InteractiveBookProps {
  book: Book;
}

export function BookListItem({
  book,
  selected = false,
  collections,
  tabIndex = 0,
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
}: BookListItemProps) {
  return (
    <div className="flex items-center gap-2">
      <BookContextMenu
        book={book}
        collections={collections}
        onOpen={onOpen}
        onRead={onRead}
        onLocate={onLocate}
        onEditMetadata={onEditMetadata}
        onRemove={onRemove}
        onAddToCollection={onAddToCollection}
        onRemoveFromCollection={onRemoveFromCollection}
        onMarkFinished={onMarkFinished}
        onReveal={onReveal}
      >
        <button
          type="button"
          data-testid="book-list-item"
          data-book-card=""
          data-book-id={book.id}
          aria-label={`${book.title} (${book.format.toUpperCase()})`}
          aria-pressed={selected}
          tabIndex={tabIndex}
          onClick={(event) => {
            event.currentTarget.focus();
            onSelect?.(book.id);
          }}
          onDoubleClick={() => onOpen?.(book.id)}
          onContextMenu={() => onSelect?.(book.id)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
            selected ? "bg-accent" : "hover:bg-accent/40",
          )}
        >
          <BookCover
            book={book}
            className={cn("h-14 w-10 shrink-0", !book.available && "opacity-40 grayscale")}
            initialClassName="text-xs"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{book.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {book.author ?? "Unknown author"}
            </p>
          </div>
          {book.format === "pdf" && <Badge variant="secondary">PDF</Badge>}
          {!book.available && <Badge variant="destructive">Missing</Badge>}
          {book.progressPercent !== null && (
            <Progress
              value={book.progressPercent}
              aria-label={`Reading progress: ${Math.round(book.progressPercent)}%`}
              title={`${Math.round(book.progressPercent)}% read`}
              className="w-24 shrink-0"
            />
          )}
        </button>
      </BookContextMenu>
      {!book.available && (
        // Row-level recovery actions, outside the interactive row button.
        <div className="flex shrink-0 gap-1" data-testid="book-list-missing">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            data-testid="missing-locate"
            onClick={() => onLocate?.(book.id)}
          >
            Locate File
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-destructive"
            data-testid="missing-remove"
            onClick={() => onRemove?.(book.id)}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}
