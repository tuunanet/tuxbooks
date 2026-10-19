import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useAnnotations } from "@/hooks/useAnnotations";
import { highlightInk } from "@/lib/highlightPalette";
import { readReaderSettings } from "@/lib/readerSettings";
import { useAppDispatch } from "@/state/appState";
import type { Annotation, Book } from "@/types/domain";

/** A readable location for a highlight when no table of contents is loaded. */
function locationLabel(annotation: Annotation): string {
  if (annotation.pageNumber !== null) return `Page ${annotation.pageNumber}`;
  if (annotation.chapterHref) {
    const path = annotation.chapterHref.split("#")[0] ?? annotation.chapterHref;
    const file = path.split("/").pop() ?? path;
    const stem = file
      .replace(/\.[^.]+$/, "")
      .replaceAll(/[-_]+/g, " ")
      .trim();
    if (stem !== "") return stem.charAt(0).toUpperCase() + stem.slice(1);
  }
  return "Highlight";
}

/**
 * Every highlight stored for one book, in document order. Rows open the
 * reader at their position; the reading surface owns editing, so the tab
 * stays a review surface rather than a second annotation editor.
 */
export function BookHighlightsPanel({ book }: { book: Book }) {
  const { annotations, loaded } = useAnnotations(book.id);
  const dispatch = useAppDispatch();
  // The palette slot is persisted; resolve it through the user's green/blue/
  // etc. overrides so the dots match what the reader paints.
  const [overrides] = useState(() => readReaderSettings().preferences.highlightOverrides);
  const highlights = annotations.filter((annotation) => annotation.kind === "highlight");

  if (!loaded) {
    return (
      <p data-testid="detail-highlights-loading" className="mt-4 text-sm text-muted-foreground">
        Loading highlights…
      </p>
    );
  }

  if (highlights.length === 0) {
    return (
      <p data-testid="detail-highlights-empty" className="mt-4 text-sm text-muted-foreground">
        No highlights yet. Select text while reading this book and pick a color; highlights appear
        here.
      </p>
    );
  }

  return (
    <div className="mt-4">
      <p className="text-sm text-muted-foreground">
        {highlights.length} {highlights.length === 1 ? "highlight" : "highlights"}
      </p>
      <ul data-testid="detail-highlights" className="mt-2 divide-y rounded-lg border">
        {highlights.map((highlight) => (
          <li key={highlight.id}>
            <button
              type="button"
              data-testid={`detail-highlight-${highlight.id}`}
              className="flex w-full items-start gap-3 px-3 py-3 text-left outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() =>
                dispatch({
                  type: "open-reader",
                  bookId: book.id,
                  annotationId: highlight.id,
                })
              }
            >
              <span
                aria-hidden
                data-testid={`detail-highlight-color-${highlight.id}`}
                className="mt-1 size-2.5 shrink-0 rounded-full border border-black/20"
                style={{ background: highlightInk(highlight.color, "light", overrides).hex }}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{highlight.text ?? "Highlight"}</span>
                {highlight.note && (
                  <span className="mt-0.5 block text-xs italic text-muted-foreground">
                    {highlight.note}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {locationLabel(highlight)}
              </span>
              <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
