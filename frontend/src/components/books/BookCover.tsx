import { cn } from "@/lib/utils";
import type { Book } from "@/types/domain";

interface BookCoverProps {
  book: Book;
  className?: string;
  initialClassName?: string;
}

/**
 * Placeholder cover art until real covers load through the Tauri asset
 * protocol (decision D2). Deliberately not an <img> — there is no cover file
 * to show yet, and pretending otherwise would fake persistence.
 */
export function BookCover({ book, className, initialClassName }: BookCoverProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary/25 via-accent to-muted ring-1 ring-foreground/10",
        className,
      )}
    >
      <span className={cn("font-semibold text-primary/50 select-none", initialClassName)}>
        {book.title.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}
