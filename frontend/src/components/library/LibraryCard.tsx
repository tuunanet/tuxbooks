import { BookCard, type InteractiveBookProps } from "@/components/books/BookCard";
import { BookListItem } from "@/components/books/BookListItem";
import type { Book } from "@/types/domain";

interface LibraryCardProps extends InteractiveBookProps {
  book: Book;
  index: number;
  isGrid: boolean;
}

/**
 * One book in the current view mode. `display: contents` keeps the wrapper
 * invisible to the row layout while carrying the index for the focus model.
 */
export function LibraryCard({ index, isGrid, book, ...props }: LibraryCardProps) {
  return (
    <div data-card-index={index} className="contents">
      {isGrid ? <BookCard book={book} {...props} /> : <BookListItem book={book} {...props} />}
    </div>
  );
}
