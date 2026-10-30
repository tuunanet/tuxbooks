import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface IndexingBadgeProps {
  className?: string;
}

/**
 * Compact marker for a book whose content hash failed. The visible text is the
 * accessible name, so a screen reader reads the same thing a sighted user sees;
 * the badge sits inside the book's own labelled card or row for context.
 */
export function IndexingBadge({ className }: IndexingBadgeProps) {
  return (
    <Badge
      variant="outline"
      role="note"
      aria-label="Not indexed"
      data-testid="book-indexing"
      className={cn("border-destructive/50 text-destructive", className)}
    >
      Not indexed
    </Badge>
  );
}
