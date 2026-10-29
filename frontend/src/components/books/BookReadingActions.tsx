import { BookOpen, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Book } from "@/lib/bridge";

interface BookReadingActionsProps {
  book: Book;
  onLocate: () => void;
  onRemoveFromLibrary: () => void;
  onContinue: () => void;
}

/**
 * The primary action for a book's current file. A disappeared file keeps its
 * row for reconnection, so recovery replaces the reading entry point rather
 * than dropping the book.
 */
export function BookReadingActions({
  book,
  onLocate,
  onRemoveFromLibrary,
  onContinue,
}: BookReadingActionsProps) {
  if (book.available) {
    return (
      <div className="mt-4 flex flex-wrap gap-2">
        <Button data-testid="detail-continue" onClick={onContinue}>
          <BookOpen data-icon="inline-start" />
          Continue Reading
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <div
        data-testid="detail-missing"
        className="w-full rounded-md border border-destructive/50 bg-destructive/10 p-3"
      >
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <FileWarning data-icon="inline-start" className="size-4" />
          File unavailable
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          The source file is missing at its recorded location. Locate it to keep this book's reading
          progress, or remove it from the library.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" data-testid="detail-locate" onClick={onLocate}>
            Locate File…
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="detail-remove"
            onClick={onRemoveFromLibrary}
          >
            Remove from Library
          </Button>
        </div>
      </div>
    </div>
  );
}
