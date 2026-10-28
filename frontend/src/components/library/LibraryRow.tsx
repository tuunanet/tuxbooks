import type { ReactNode } from "react";
import type { Book } from "@/types/domain";

interface LibraryRowProps {
  books: Book[];
  rowIndex: number;
  columnCount: number;
  isGrid: boolean;
  renderCard: (book: Book, index: number) => ReactNode;
}

/** One grid row (a slice of the visible books) or one list row. */
export function LibraryRow({ books, rowIndex, columnCount, isGrid, renderCard }: LibraryRowProps) {
  const start = rowIndex * columnCount;
  const rowBooks = isGrid
    ? books.slice(start, start + columnCount)
    : books.slice(rowIndex, rowIndex + 1);

  return isGrid ? (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
    >
      {rowBooks.map((book, offset) => renderCard(book, start + offset))}
    </div>
  ) : (
    <div className="pb-1">
      {rowBooks.map((book, offset) => renderCard(book, rowIndex + offset))}
    </div>
  );
}

interface VirtualRowProps {
  index: number;
  start: number;
  measure: (node: Element | null) => void;
  children: ReactNode;
}

/** The absolutely positioned window slot the virtualizer hands rows. */
export function VirtualRow({ index, start, measure, children }: VirtualRowProps) {
  return (
    <div
      data-index={index}
      ref={measure}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${start}px)`,
      }}
    >
      {children}
    </div>
  );
}
