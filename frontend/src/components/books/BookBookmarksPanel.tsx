import { ChevronRight } from "lucide-react";
import { useAnnotations } from "@/hooks/useAnnotations";
import { annotationLocationLabel } from "@/lib/annotationLocation";
import { useAppDispatch } from "@/state/appState";
import type { Book } from "@/types/domain";

/**
 * Every bookmark stored for one book, in document order. Rows open the reader
 * at their position; the reading surface owns editing, so the tab stays a
 * review surface.
 */
export function BookBookmarksPanel({ book }: { book: Book }) {
  const { annotations, loaded } = useAnnotations(book.id);
  const dispatch = useAppDispatch();
  const bookmarks = annotations.filter((annotation) => annotation.kind === "bookmark");

  if (!loaded) {
    return (
      <p data-testid="detail-bookmarks-loading" className="mt-4 text-sm text-muted-foreground">
        Loading bookmarks…
      </p>
    );
  }

  if (bookmarks.length === 0) {
    return (
      <p data-testid="detail-bookmarks-empty" className="mt-4 text-sm text-muted-foreground">
        No bookmarks yet. Use the bookmark action while reading this book; bookmarks appear here.
      </p>
    );
  }

  return (
    <div className="mt-4">
      <p className="text-sm text-muted-foreground">
        {bookmarks.length} {bookmarks.length === 1 ? "bookmark" : "bookmarks"}
      </p>
      <ul data-testid="detail-bookmarks" className="mt-2 divide-y rounded-lg border">
        {bookmarks.map((bookmark) => (
          <li key={bookmark.id}>
            <button
              type="button"
              data-testid={`detail-bookmark-${bookmark.id}`}
              className="flex w-full items-start gap-3 px-3 py-3 text-left outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() =>
                dispatch({
                  type: "open-reader",
                  bookId: book.id,
                  annotationId: bookmark.id,
                })
              }
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{annotationLocationLabel(bookmark)}</span>
                {bookmark.note && (
                  <span className="mt-0.5 block text-xs italic text-muted-foreground">
                    {bookmark.note}
                  </span>
                )}
              </span>
              <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
