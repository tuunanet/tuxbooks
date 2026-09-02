import { useRef, useState } from "react";
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  PanelLeft,
  Search,
  TableOfContents,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcut } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useLibrary } from "@/hooks/useLibrary";
import { useAppDispatch, useAppState } from "@/state/appState";
import { useReader, type ReaderTheme } from "@/state/readerState";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "./placeholderDocument";
import { pageToPosition } from "./pdf/pdfPages";
import type { EpubTocItem } from "@/lib/epub/epubEngine";
import type { PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import { EpubReader } from "./EpubReader";
import { PdfReader } from "./pdf/PdfReader";
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
 * session state; persistence goes through the backend progress commands.
 */
export function ReaderShell() {
  const { selectedBookId } = useAppState();
  const { books } = useLibrary();
  const dispatch = useAppDispatch();
  const { preferences, position, setPosition, bookmarks, toggleBookmark } = useReader();
  const [navOpen, setNavOpen] = useState(false);
  // Real PDF page count, reported by PdfReader once the document loads.
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  // Real EPUB table of contents, reported by EpubReader once the engine
  // opens the book; EPUB navigation goes through the engine's destinations.
  // Kept with its owning book id so a stale book's TOC is never shown —
  // the derived value resets without a setState-in-effect.
  const [epubTocState, setEpubTocState] = useState<{
    bookId: number;
    toc: EpubTocItem[];
  } | null>(null);
  const epubJumpRef = useRef<((href: string) => void) | null>(null);
  // Real PDF outline, reported by PdfReader once the engine resolves it.
  // Kept with its owning book id so a stale book's outline is never shown.
  const [pdfOutlineState, setPdfOutlineState] = useState<{
    bookId: number;
    outline: PdfOutlineItem[];
  } | null>(null);
  // PDF thumbnails sidebar: the shell owns the docked host and the toggle;
  // PdfReader fills the host through a portal (it owns the document handle).
  const [pdfSidebarOpen, setPdfSidebarOpen] = useState(false);
  const [pdfSidebarHost, setPdfSidebarHost] = useState<HTMLElement | null>(null);
  // The reading scroll surface; PDF page tracking and PageUp/PageDown live here.
  const readerContentRef = useRef<HTMLElement | null>(null);

  const book = books.find((candidate) => candidate.id === selectedBookId) ?? null;
  const isPdf = book?.format === "pdf";
  const isEpub = book?.format === "epub";
  const epubToc =
    epubTocState !== null && epubTocState.bookId === book?.id ? epubTocState.toc : null;
  const pdfOutline =
    pdfOutlineState !== null && pdfOutlineState.bookId === book?.id
      ? pdfOutlineState.outline
      : null;
  const pageCount = isPdf ? (pdfPageCount ?? PDF_PLACEHOLDER_PAGE_COUNT) : 0;
  // The pages drawer lists real pages only; 0 keeps it in its loading state.
  const knownPageCount = isPdf ? (pdfPageCount ?? 0) : 0;
  // Percentage stepping is only meaningful with a known page count; the
  // EPUB surface owns these keys instead (engine page turns).
  const step = pageCount > 0 ? 100 / pageCount : 0;

  useShortcut("home", () => setPosition(0));
  useShortcut("end", () => setPosition(100));
  useShortcut("mod+b", () => toggleBookmark());
  // Arrow/space stepping and PageUp/PageDown scrolling are PDF behaviors:
  // they are not registered while an EPUB is open, where EpubReader owns
  // those combos outright (engine page turns) regardless of registration
  // order — a shell percentage step with no page count would clamp straight
  // to the beginning or end of the document.
  useShortcut(isEpub ? null : "arrowright", () => setPosition(position + step));
  useShortcut(isEpub ? null : "space", () => setPosition(position + step));
  useShortcut(isEpub ? null : "arrowleft", () => setPosition(position - step));
  useShortcut(isEpub ? null : "pagedown", () => {
    const container = readerContentRef.current;
    if (container) container.scrollTop += container.clientHeight * 0.9;
  });
  useShortcut(isEpub ? null : "pageup", () => {
    const container = readerContentRef.current;
    if (container) container.scrollTop -= container.clientHeight * 0.9;
  });

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

        {isPdf && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="reader-sidebar-toggle"
                aria-label="Toggle page thumbnails"
                aria-pressed={pdfSidebarOpen}
                onClick={() => setPdfSidebarOpen((open) => !open)}
              >
                <PanelLeft />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Page thumbnails</TooltipContent>
          </Tooltip>
        )}

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

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {isPdf && pdfSidebarOpen && (
          <aside
            ref={setPdfSidebarHost}
            data-testid="pdf-sidebar"
            aria-label="Page thumbnails"
            className="h-full w-44 shrink-0 overflow-hidden border-r"
          />
        )}
        <main
          ref={readerContentRef}
          data-testid="reader-content"
          aria-label="Reading view"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {isEpub ? (
            <EpubReader
              key={book.id}
              book={book}
              onTocLoad={(toc) => setEpubTocState({ bookId: book.id, toc })}
              jumpTargetRef={epubJumpRef}
            />
          ) : (
            <PdfReader
              key={book.id}
              book={book}
              onDocumentLoad={setPdfPageCount}
              onOutlineLoad={(outline) => setPdfOutlineState({ bookId: book.id, outline })}
              sidebarHost={pdfSidebarHost}
              scrollContainerRef={readerContentRef}
            />
          )}
        </main>
      </div>

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
        pageCount={knownPageCount}
        onJump={setPosition}
        epubToc={isEpub ? epubToc : null}
        onEpubJump={(href) => epubJumpRef.current?.(href)}
        pdfOutline={isPdf ? pdfOutline : null}
        onPdfJump={(page) => {
          if (knownPageCount > 0) setPosition(pageToPosition(page, knownPageCount));
        }}
      />
    </div>
  );
}
