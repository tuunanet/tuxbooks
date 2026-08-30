import { Badge } from "@/components/ui/badge";
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
  progress,
  tabIndex = 0,
  onSelect,
  onOpen,
  onRead,
}: BookListItemProps) {
  return (
    <BookContextMenu book={book} onOpen={onOpen} onRead={onRead}>
      <button
        type="button"
        data-testid="book-list-item"
        data-book-card=""
        data-book-id={book.id}
        aria-pressed={selected}
        tabIndex={tabIndex}
        onClick={(event) => {
          event.currentTarget.focus();
          onSelect?.(book.id);
        }}
        onDoubleClick={() => onOpen?.(book.id)}
        onContextMenu={() => onSelect?.(book.id)}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
          selected ? "bg-accent" : "hover:bg-accent/40",
        )}
      >
        <BookCover book={book} className="h-14 w-10 shrink-0" initialClassName="text-xs" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{book.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {book.author ?? "Unknown author"}
          </p>
        </div>
        {book.format === "pdf" && <Badge variant="secondary">PDF</Badge>}
        {progress && (
          <Progress
            value={progress.percentage}
            aria-label={`Reading progress: ${progress.percentage}%`}
            title={`${progress.percentage}% read`}
            className="w-24 shrink-0"
          />
        )}
      </button>
    </BookContextMenu>
  );
}
