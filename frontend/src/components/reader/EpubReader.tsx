import { useMemo } from "react";
import { useReader } from "@/state/readerState";
import { cn } from "@/lib/utils";
import { epubPlaceholderPages } from "./placeholderDocument";
import type { Book } from "@/types/domain";

/**
 * EPUB reading surface placeholder. No rendering engine yet: the shell shows
 * original stand-in prose so pagination, appearance, and navigation behave.
 * The real engine (CFI positioning, reflow) replaces the content, not the
 * chrome around it.
 */
export function EpubReader({ book }: { book: Book }) {
  const { preferences, position } = useReader();
  const pages = useMemo(() => epubPlaceholderPages(), []);

  const clamped = Math.max(0, Math.min(100, position));
  const pageIndex =
    preferences.layout === "paginated"
      ? Math.min(Math.floor((clamped / 100) * pages.length), pages.length - 1)
      : null;
  const visible = pageIndex === null ? pages : pages.slice(pageIndex, pageIndex + 1);

  return (
    <article
      data-testid="epub-reader"
      data-layout={preferences.layout}
      className="mx-auto max-w-prose px-6 py-10"
      style={{
        fontSize: `${preferences.fontSize}px`,
        lineHeight: preferences.lineHeight,
      }}
    >
      <header className="mb-8 border-b pb-4">
        <p className="text-xs tracking-wide text-muted-foreground uppercase">{book.title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{book.author ?? "Unknown author"}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Placeholder document — the real EPUB renderer arrives with the reader engine.
        </p>
      </header>
      {visible.map((page, index) => (
        <section
          key={pageIndex === null ? index : pageIndex}
          data-testid="epub-page"
          className={cn(index > 0 && "mt-10")}
        >
          {page.heading && <h2 className="mb-4 text-xl font-semibold">{page.heading}</h2>}
          {page.paragraphs.map((paragraph, paragraphIndex) => (
            <p key={paragraphIndex} className={cn(paragraphIndex > 0 && "mt-4", "indent-8")}>
              {paragraph}
            </p>
          ))}
        </section>
      ))}
      {pageIndex !== null && (
        <p className="mt-12 text-center text-xs text-muted-foreground tabular-nums">
          Page {pageIndex + 1} of {pages.length}
        </p>
      )}
    </article>
  );
}
