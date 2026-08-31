import { useState } from "react";
import { ArrowLeft, Bookmark, BookmarkCheck, Search, TableOfContents } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcut } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useLibrary } from "@/hooks/useLibrary";
import { useAppDispatch, useAppState } from "@/state/appState";
import { useReader, type ReaderTheme } from "@/state/readerState";
import { EPUB_PLACEHOLDER_PAGE_COUNT, PDF_PLACEHOLDER_PAGE_COUNT } from "./placeholderDocument";
import { EpubReader } from "./EpubReader";
import { PdfReader } from "./PdfReader";
import { ReaderNavigation } from "./ReaderNavigation";
import { ReaderAppearance } from "./ReaderAppearance";

const THEME_CLASSES: Record<ReaderTheme, string> = {
  light: "bg-background text-foreground",
  paper: "bg-[#f6f0e4] text-[#3a332a]",
  dark: "bg-zinc-950 text-zinc-100",
};

/**
 * Full-window reading mode: no sidebar, its own visual language, and a
 * distinct visual language from the library. Position and appearance are
 * session state; persistence waits for the backend progress commands.
 */
export function ReaderShell() {
  const { selectedBookId } = useAppState();
  const { books } = useLibrary();
  const dispatch = useAppDispatch();
  const { preferences, position, setPosition, bookmarks, toggleBookmark } = useReader();
  const [navOpen, setNavOpen] = useState(false);

  const book = books.find((candidate) => candidate.id === selectedBookId) ?? null;
  const pageCount =
    book?.format === "pdf" ? PDF_PLACEHOLDER_PAGE_COUNT : EPUB_PLACEHOLDER_PAGE_COUNT;
  const step = 100 / pageCount;

  useShortcut("arrowright", () => setPosition(position + step));
  useShortcut("space", () => setPosition(position + step));
  useShortcut("arrowleft", () => setPosition(position - step));
  useShortcut("home", () => setPosition(0));
  useShortcut("end", () => setPosition(100));
  useShortcut("mod+b", () => toggleBookmark());

  const bookmarked = bookmarks.some(
    (bookmark) => Math.round(bookmark.percentage) === Math.round(position),
  );

  if (!book) {
    return (
      <div
        data-testid="reader-view"
        className="flex h-screen flex-col items-center justify-center gap-3"
      >
        <h2 className="text-xl font-semibold">This book is no longer in the library</h2>
        <Button variant="outline" size="sm" onClick={() => dispatch({ type: "return-to-library" })}>
          <ArrowLeft data-icon="inline-start" />
          Back to Library
        </Button>
      </div>
    );
  }

  return (
    <div
      data-testid="reader-view"
      data-theme={preferences.theme}
      className={cn("flex h-screen flex-col overflow-hidden", THEME_CLASSES[preferences.theme])}
    >
      <header className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="reader-back"
              aria-label="Back to Library"
              onClick={() => dispatch({ type: "return-to-library" })}
            >
              <ArrowLeft />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back to Library</TooltipContent>
        </Tooltip>

        <div className="min-w-0 flex-1 px-2 text-center">
          <p data-testid="reader-title" className="truncate text-sm font-medium">
            {book.title}
          </p>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Search document"
                disabled
                title="Search arrives with the real document renderer"
              >
                <Search />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Search (not wired up yet)</TooltipContent>
        </Tooltip>

        <ReaderAppearance />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="reader-nav-trigger"
              aria-label="Contents and bookmarks"
              onClick={() => setNavOpen(true)}
            >
              <TableOfContents />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Contents</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="reader-bookmark"
              aria-label={bookmarked ? "Remove bookmark" : "Add bookmark"}
              aria-pressed={bookmarked}
              onClick={() => toggleBookmark()}
            >
              {bookmarked ? <BookmarkCheck className="fill-current" /> : <Bookmark />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Bookmark (Ctrl+B)</TooltipContent>
        </Tooltip>
      </header>

      <main
        data-testid="reader-content"
        aria-label="Reading view"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {book.format === "epub" ? <EpubReader book={book} /> : <PdfReader book={book} />}
      </main>

      <footer className="shrink-0 border-t px-4 py-2">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Progress
            data-testid="reader-progress"
            aria-label="Reading position"
            value={position}
            className="flex-1"
          />
          <span
            data-testid="reader-position"
            className="w-10 text-right text-xs text-muted-foreground tabular-nums"
          >
            {Math.round(position)}%
          </span>
        </div>
      </footer>

      <ReaderNavigation
        open={navOpen}
        onOpenChange={setNavOpen}
        book={book}
        pageCount={pageCount}
        onJump={setPosition}
      />
    </div>
  );
}
