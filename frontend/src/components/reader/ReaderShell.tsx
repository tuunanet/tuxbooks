import { useCallback, useMemo, useRef, useState } from "react";
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
import { useAnnotations } from "@/hooks/useAnnotations";
import { useLibrary } from "@/hooks/useLibrary";
import { useAppDispatch, useAppState } from "@/state/appState";
import { useReader, type ReaderTheme } from "@/state/readerState";
import { byKind, type HighlightColor } from "./annotationModel";
import {
  bookmarkInputFor,
  isBookmarkAtPosition,
  jumpToAnnotation as annotationJumpTarget,
  jumpToSearchMatch,
  type ReaderAdapter,
  type ReaderJump,
  type ReaderPosition,
} from "./readerModel";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "./placeholderDocument";
import type { EpubTocItem } from "@/lib/epub/epubEngine";
import type { PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import type { Annotation, AnnotationInput } from "@/types/domain";
import { EpubReader } from "./EpubReader";
import { PdfReader } from "./pdf/PdfReader";
import { ReaderNavigation, type ReaderNavTab } from "./ReaderNavigation";
import { ReaderAppearance } from "./ReaderAppearance";
import { SelectionToolbar } from "./SelectionToolbar";
import {
  appendSearchGroup,
  emptySearchState,
  finishSearchGroup,
  type ReaderSearchGroup,
  type ReaderSearchMatch,
  type ReaderSearchState,
} from "./searchModel";

const THEME_CLASSES: Record<ReaderTheme, string> = {
  light: "bg-background text-foreground",
  paper: "bg-[#f6f0e4] text-[#3a332a]",
  dark: "bg-zinc-950 text-zinc-100",
};

/**
 * Full-window reading mode: no sidebar, its own visual language, and a
 * distinct visual language from the library. The shell owns the genuinely
 * shared reader concepts — current book, progress, navigation, bookmark
 * placement, in-book search state, and the selection toolbar — while the
 * open format reader (EPUB or PDF) registers its adapter (`readerModel`)
 * for jumps, search, and highlight creation. Position persistence lives in
 * the shared useReaderProgress contract; the format adapters keep their
 * own rendering models and engines.
 */
export function ReaderShell() {
  const { selectedBookId } = useAppState();
  const { books } = useLibrary();
  const dispatch = useAppDispatch();
  const { preferences, position, setPosition } = useReader();
  // The navigation drawer plus its selected tab: the Search toolbar button
  // and Ctrl/Cmd+F open the drawer straight onto the Search tab.
  const [nav, setNav] = useState<{ open: boolean; tab: ReaderNavTab }>({
    open: false,
    tab: "contents",
  });
  const openNav = (tab: ReaderNavTab) => setNav({ open: true, tab });
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
  // Real PDF outline, reported by PdfReader once the engine resolves it.
  // Kept with its owning book id so a stale book's outline is never shown.
  const [pdfOutlineState, setPdfOutlineState] = useState<{
    bookId: number;
    outline: PdfOutlineItem[];
  } | null>(null);
  // The open reader's adapter: how the shell jumps, searches, and creates
  // highlights without knowing which engine is underneath. Registered while
  // the reader's document is open, nulled on unmount/book switch.
  const adapterRef = useRef<ReaderAdapter | null>(null);
  // The open reader's latest position (EPUB CFI / PDF page), tagged with
  // its book id for the same staleness guard. Written through the unified
  // onPositionChange callback; relocates already re-render the shell, so
  // keeping this in state costs nothing extra and keeps `bookmarked`
  // render-honest.
  const [reportedPosition, setReportedPosition] = useState<{
    bookId: number;
    position: ReaderPosition;
  } | null>(null);
  // Streaming in-book search results for the open book (shared model for
  // both formats; stale books' results are ignored by the model helpers).
  const [searchState, setSearchState] = useState<ReaderSearchState | null>(null);
  // PDF thumbnails sidebar: the shell owns the docked host and the toggle;
  // PdfReader fills the host through a portal (it owns the document handle).
  const [pdfSidebarOpen, setPdfSidebarOpen] = useState(false);
  const [pdfSidebarHost, setPdfSidebarHost] = useState<HTMLElement | null>(null);
  // The reading scroll surface; PDF page tracking and PageUp/PageDown live here.
  const readerContentRef = useRef<HTMLElement | null>(null);

  const book = books.find((candidate) => candidate.id === selectedBookId) ?? null;
  const isPdf = book?.format === "pdf";
  const isEpub = book?.format === "epub";
  // Persistent annotations of the open book: bookmarks, highlights, notes.
  const { annotations, create, remove, update } = useAnnotations(book?.id ?? null);
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
  useShortcut("mod+f", () => openNav("search"));

  // In-book search: the shell owns the state (one book open at a time), the
  // open reader's adapter streams matches in through the shared model
  // helpers, which ignore anything not belonging to the book being searched.
  const bookId = book?.id ?? -1;
  const runSearch = useCallback(
    (query: string) => {
      if (query === "") {
        adapterRef.current?.search.cancel();
        setSearchState(null);
        return;
      }
      setSearchState(emptySearchState(bookId, query));
      adapterRef.current?.search.run(query);
    },
    [bookId],
  );
  const appendSearchGroupFrom = useCallback((id: number, group: ReaderSearchGroup) => {
    setSearchState((prev) => (prev ? appendSearchGroup(prev, id, group) : prev));
  }, []);
  const finishSearchFrom = useCallback((id: number) => {
    setSearchState((prev) => (prev ? finishSearchGroup(prev, id) : prev));
  }, []);
  // Every navigation entry point funnels through the open adapter: search
  // matches, annotations, TOC entries, outline entries, and pages all jump
  // in the document's own coordinates.
  const jump = useCallback((target: ReaderJump) => {
    adapterRef.current?.jump(target);
  }, []);
  const pickSearchMatch = useCallback(
    (match: ReaderSearchMatch) => {
      const target = jumpToSearchMatch(match);
      if (target) jump(target);
    },
    [jump],
  );
  const jumpToAnnotation = useCallback(
    (annotation: Annotation) => {
      const target = annotationJumpTarget(annotation);
      if (target) jump(target);
    },
    [jump],
  );

  // Selection toolbar state, tagged with the book whose reader reported it
  // (readers remount per book, so a stale book can never write here).
  const [selection, setSelection] = useState<{ bookId: number; text: string } | null>(null);
  const activeSelection =
    selection !== null && selection.bookId === book?.id ? { text: selection.text } : null;

  const activePosition =
    reportedPosition !== null && reportedPosition.bookId === book?.id
      ? reportedPosition.position
      : null;

  // Bookmarks: toggle at the exact current position (EPUB CFI / PDF page),
  // so the button also removes a bookmark placed on the same spot.
  const toggleBookmark = useCallback(() => {
    if (!activePosition) return;
    const existing = annotations.find((annotation) =>
      isBookmarkAtPosition(annotation, activePosition),
    );
    if (existing) void remove(existing.id);
    else void create(bookmarkInputFor(activePosition));
  }, [activePosition, annotations, create, remove]);
  useShortcut("mod+b", toggleBookmark);

  const bookmarked =
    activePosition !== null &&
    annotations.some((annotation) => isBookmarkAtPosition(annotation, activePosition));

  const handleCreateHighlight = useCallback(
    (input: AnnotationInput) => {
      void create(input);
    },
    [create],
  );
  const handleSelectionFrom = useCallback((id: number, text: string | null) => {
    setSelection(text === null ? null : { bookId: id, text });
  }, []);
  const handleCreateHighlightColor = useCallback((color: HighlightColor) => {
    adapterRef.current?.annotations.createHighlight(color);
  }, []);
  const handleDismissSelection = useCallback(() => {
    adapterRef.current?.annotations.clearSelection();
  }, []);

  const highlights = useMemo(() => byKind(annotations, "highlight"), [annotations]);

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
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="reader-search"
              aria-label="Search in book"
              onClick={() => openNav("search")}
            >
              <Search />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Search in book (Ctrl+F)</TooltipContent>
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
              onClick={() => openNav(isEpub ? "contents" : "pages")}
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
              onPositionChange={(position) => setReportedPosition({ bookId: book.id, position })}
              adapterRef={adapterRef}
              onSearchGroup={appendSearchGroupFrom}
              onSearchDone={finishSearchFrom}
              highlights={highlights}
              onCreateHighlight={handleCreateHighlight}
              onSelectionChange={(sel) =>
                handleSelectionFrom(book.id, sel === null ? null : sel.text)
              }
            />
          ) : (
            <PdfReader
              key={book.id}
              book={book}
              onDocumentLoad={setPdfPageCount}
              onOutlineLoad={(outline) => setPdfOutlineState({ bookId: book.id, outline })}
              sidebarHost={pdfSidebarHost}
              scrollContainerRef={readerContentRef}
              onPositionChange={(position) => setReportedPosition({ bookId: book.id, position })}
              adapterRef={adapterRef}
              onSearchGroup={appendSearchGroupFrom}
              onSearchDone={finishSearchFrom}
              highlights={highlights}
              onCreateHighlight={handleCreateHighlight}
              onSelectionChange={(sel) =>
                handleSelectionFrom(book.id, sel === null ? null : sel.text)
              }
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
        open={nav.open}
        onOpenChange={(open) => setNav((prev) => ({ ...prev, open }))}
        book={book}
        pageCount={knownPageCount}
        onJump={jump}
        epubToc={isEpub ? epubToc : null}
        pdfOutline={isPdf ? pdfOutline : null}
        annotations={annotations}
        onAnnotationJump={jumpToAnnotation}
        onDeleteAnnotation={(id) => void remove(id)}
        onUpdateAnnotation={(id, patch) => void update(id, patch)}
        search={searchState !== null && searchState.bookId === book.id ? searchState : null}
        onSearch={runSearch}
        onSearchPick={pickSearchMatch}
        tab={nav.tab}
        onTabChange={(tab) => setNav((prev) => ({ ...prev, tab }))}
      />

      <SelectionToolbar
        selection={activeSelection}
        onCreate={handleCreateHighlightColor}
        onDismiss={handleDismissSelection}
      />
    </div>
  );
}
