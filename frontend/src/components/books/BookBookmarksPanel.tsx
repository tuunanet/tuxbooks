import { useState } from "react";
import { ChevronRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAnnotations } from "@/hooks/useAnnotations";
import {
  bookmarkLocationAndProgress,
  bookmarkProgress,
  bookmarkSavedLabel,
  bookmarkTitle,
  clampBookmarkLabel,
} from "@/lib/annotationLocation";
import { useAppDispatch } from "@/state/appState";
import type { Book } from "@/types/domain";

/**
 * Every bookmark stored for one book, in document order. Rows show the short
 * label when one is set, otherwise the chapter/page and in-chapter progress.
 * The label is editable here; the reader drawer offers the same editor.
 */
export function BookBookmarksPanel({ book }: { book: Book }) {
  const { annotations, loaded, update } = useAnnotations(book.id);
  const dispatch = useAppDispatch();
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null);
  const bookmarks = annotations.filter((annotation) => annotation.kind === "bookmark");

  const saveLabel = (id: number, draft: string) => {
    void update(id, { label: draft.trim() });
    setEditing(null);
  };

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
        {bookmarks.map((bookmark) => {
          const title = bookmarkTitle(bookmark);
          const location = bookmarkLocationAndProgress(bookmark);
          const progress = bookmarkProgress(bookmark);
          const detail = [title === location ? null : location, bookmarkSavedLabel(bookmark)]
            .filter((part) => part !== null)
            .join(" · ");
          return (
            <li key={bookmark.id}>
              <div className="flex items-start gap-2 px-3 py-3">
                <button
                  type="button"
                  data-testid={`detail-bookmark-${bookmark.id}`}
                  className="min-w-0 flex-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() =>
                    dispatch({
                      type: "open-reader",
                      bookId: book.id,
                      annotationId: bookmark.id,
                    })
                  }
                >
                  <span className="block text-sm">{title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
                  {progress !== null && (
                    <span
                      aria-hidden
                      data-testid={`detail-bookmark-progress-${bookmark.id}`}
                      className="mt-1.5 block h-0.5 overflow-hidden rounded-full bg-muted"
                    >
                      <span
                        className="block h-full rounded-full bg-foreground/40"
                        style={{ width: `${progress.fraction * 100}%` }}
                      />
                    </span>
                  )}
                  {bookmark.note && (
                    <span className="mt-0.5 block text-xs italic text-muted-foreground">
                      {bookmark.note}
                    </span>
                  )}
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  data-testid={`detail-bookmark-label-${bookmark.id}`}
                  aria-label={bookmark.label ? "Edit bookmark label" : "Add bookmark label"}
                  onClick={() =>
                    setEditing((current) =>
                      current?.id === bookmark.id
                        ? null
                        : { id: bookmark.id, draft: bookmark.label ?? "" },
                    )
                  }
                >
                  <Pencil />
                </Button>
                <ChevronRight
                  aria-hidden
                  className="mt-1.5 size-4 shrink-0 text-muted-foreground"
                />
              </div>
              {editing?.id === bookmark.id && (
                <form
                  className="space-y-2 px-3 pb-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveLabel(bookmark.id, editing.draft);
                  }}
                >
                  <label className="block text-xs font-medium text-muted-foreground">
                    Bookmark label
                    <input
                      data-testid="detail-bookmark-label-input"
                      value={editing.draft}
                      onChange={(event) =>
                        setEditing({
                          id: bookmark.id,
                          draft: clampBookmarkLabel(event.target.value),
                        })
                      }
                      placeholder="Short description"
                      className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                  </label>
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="detail-bookmark-label-cancel"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" data-testid="detail-bookmark-label-save">
                      Save
                    </Button>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
