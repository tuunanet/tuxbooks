import { useReader } from "@/state/readerState";
import { cn } from "@/lib/utils";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "./placeholderDocument";
import type { Book } from "@/types/domain";

/** Deterministic skeleton-line widths so the placeholder canvas feels like text. */
const LINE_WIDTHS = [92, 100, 84, 96, 68, 98, 88, 74, 95, 60];

/**
 * PDF reading surface placeholder. No PDF engine yet: a page canvas with
 * skeleton text keeps paging, position, and the Pages drawer honest.
 */
export function PdfReader({ book }: { book: Book }) {
  const { position } = useReader();

  const clamped = Math.max(0, Math.min(100, position));
  const currentPage = Math.min(
    Math.max(1, Math.round((clamped / 100) * (PDF_PLACEHOLDER_PAGE_COUNT - 1)) + 1),
    PDF_PLACEHOLDER_PAGE_COUNT,
  );

  return (
    <div data-testid="pdf-reader" className="mx-auto max-w-3xl px-6 py-8">
      <p className="mb-4 text-center text-xs text-muted-foreground">
        {book.title} — placeholder document, the real PDF renderer arrives with the reader engine.
      </p>
      <div className="mx-auto flex aspect-[3/4] max-w-xl flex-col rounded-lg border bg-popover p-10 shadow-sm">
        <div className="flex-1 space-y-3 overflow-hidden">
          {LINE_WIDTHS.map((width, index) => (
            <div
              key={index}
              className={cn("h-2.5 rounded-sm bg-muted", index === 0 && "mt-2 h-3 w-1/3 bg-accent")}
              style={{ width: `${width}%` }}
            />
          ))}
          <div className="mt-8 space-y-3">
            {LINE_WIDTHS.slice(0, 6).map((width, index) => (
              <div
                key={`second-${index}`}
                className="h-2.5 rounded-sm bg-muted"
                style={{ width: `${width}%` }}
              />
            ))}
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground tabular-nums">
          Page {currentPage} of {PDF_PLACEHOLDER_PAGE_COUNT}
        </p>
      </div>
    </div>
  );
}
