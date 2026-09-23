import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  formatShortcutAria,
  formatShortcutDisplay,
  READER_PANEL_SHORTCUTS,
} from "@/lib/readerShortcuts";
import { epubSurfaceTheme, readerPopoverVariables, type ReaderTheme } from "@/lib/epub/appearance";
import type { EpubTocItem } from "@/lib/epub/readiumEngine";
import type { PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import type { Annotation, AnnotationPatch } from "@/types/domain";
import type { Book } from "@/types/domain";
import { epubHrefJump, type ReaderJump } from "./readerModel";
import { ReaderAnnotationList } from "./ReaderAnnotationTabs";
import { ReaderSearchTab } from "./ReaderSearchTab";
import type { ReaderSearchMatch, ReaderSearchState } from "./searchModel";

export type ReaderNavTab = "contents" | "pages" | "outline" | "bookmarks" | "highlights" | "search";

interface ReaderNavigationProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  book: Book;
  pageCount: number;
  /** Navigates the open reader to a position in the document's own coordinates. */
  onJump: (target: ReaderJump) => void;
  /** Engine-reported EPUB table of contents; null while the book opens. */
  epubToc: EpubTocItem[] | null;
  /** Engine-resolved PDF outline; null while the document opens. */
  pdfOutline: PdfOutlineItem[] | null;
  /** Persistent annotations of the open book (bookmarks + highlights). */
  annotations: Annotation[];
  /** Navigates the reader to an annotation's position. */
  onAnnotationJump: (annotation: Annotation) => void;
  /** Deletes a persistent annotation. */
  onDeleteAnnotation: (id: number) => void;
  /** Updates an annotation's color and/or note. */
  onUpdateAnnotation: (id: number, patch: AnnotationPatch) => void;
  /** In-book search state for the open book; null before the first search. */
  search: ReaderSearchState | null;
  /** Starts (or clears) the in-book search for the open book. */
  onSearch: (query: string) => void;
  /** Navigates to an in-book search match. */
  onSearchPick: (match: ReaderSearchMatch) => void;
  /** The selected navigation tab (controlled by the shell). */
  tab: ReaderNavTab;
  onTabChange: (tab: ReaderNavTab) => void;
  /** Active reader theme; the portaled sheet re-themes its app tokens to it. */
  theme: ReaderTheme;
}

/** Trigger metadata for one drawer tab: label, testid, and hint copy. */
interface ReaderNavTabHint {
  label: string;
  testId: string;
  /** One-line description; the shortcut renders after it when the tab has one. */
  description: string;
  /** Engine combo; shown in the hint and exposed through `aria-keyshortcuts`. */
  combo?: string;
}

/**
 * Hint copy keyed by tab value so the triggers stay in one place. Pages and
 * Contents share the contents combo: the header's Contents button opens the
 * drawer onto Pages for a PDF and Contents for an EPUB.
 */
const NAV_TAB_HINTS: Record<ReaderNavTab, ReaderNavTabHint> = {
  contents: {
    label: "Contents",
    testId: "nav-tab-contents",
    description: "The book's chapters, in order.",
    combo: READER_PANEL_SHORTCUTS.contents,
  },
  pages: {
    label: "Pages",
    testId: "nav-tab-pages",
    description: "Thumbnails of every page, click one to jump there.",
    combo: READER_PANEL_SHORTCUTS.contents,
  },
  outline: {
    label: "Outline",
    testId: "nav-tab-outline",
    description: "The document's own headings, in order.",
  },
  bookmarks: {
    label: "Bookmarks",
    testId: "nav-tab-bookmarks",
    description: "Pages you saved, so you can return to them.",
    combo: READER_PANEL_SHORTCUTS.bookmarks,
  },
  highlights: {
    label: "Highlights",
    testId: "nav-tab-highlights",
    description: "Text you highlighted, with any notes you added.",
    combo: READER_PANEL_SHORTCUTS.highlights,
  },
  search: {
    label: "Search",
    testId: "nav-tab-search",
    description: "Find text in this book.",
    combo: "mod+f",
  },
};

/** A drawer tab trigger with its hover/focus hint and `aria-keyshortcuts`. */
function navTabTrigger(value: ReaderNavTab, selected: boolean) {
  const { label, testId, description, combo } = NAV_TAB_HINTS[value];
  return (
    <Tooltip>
      <TooltipTrigger
        asChild
        // Radix's tooltip trigger stamps its own `data-state` (open/closed)
        // onto the child; without this it would overwrite the tab's
        // active/inactive state that drives its styling.
        data-state={selected ? "active" : "inactive"}
      >
        <TabsTrigger
          data-testid={testId}
          value={value}
          aria-keyshortcuts={combo ? formatShortcutAria(combo) : undefined}
        >
          {label}
        </TabsTrigger>
      </TooltipTrigger>
      <TooltipContent>
        {description}
        {combo ? ` (${formatShortcutDisplay(combo, false)})` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

/** Flattens a TOC tree into rows with their nesting depth. */
interface TocRow {
  item: EpubTocItem;
  depth: number;
}

function flattenToc(items: EpubTocItem[], depth = 0): TocRow[] {
  return items.flatMap((item) => [{ item, depth }, ...flattenToc(item.subitems, depth + 1)]);
}

/** Flattens an outline tree into rows with their nesting depth. */
interface OutlineRow {
  item: PdfOutlineItem;
  depth: number;
}

function flattenOutline(items: PdfOutlineItem[], depth = 0): OutlineRow[] {
  return items.flatMap((item) => [{ item, depth }, ...flattenOutline(item.items, depth + 1)]);
}

/** TOC label for a spine href, or null when the book has no matching entry. */
function tocLabelFor(epubToc: EpubTocItem[] | null, href: string): string | null {
  if (!epubToc) return null;
  for (const { item } of flattenToc(epubToc)) {
    if (item.href === href) return item.label || item.href;
  }
  return null;
}

/**
 * Reading navigation drawer: EPUB contents from the Readium engine (real
 * labels, real destinations); PDF pages, thumbnails, and outline from the
 * loaded PDFium document; persistent bookmarks, highlights, and notes from
 * the backend annotations; in-book search streamed from the open book's
 * reader.
 */
export function ReaderNavigation({
  open,
  onOpenChange,
  book,
  pageCount,
  onJump,
  epubToc,
  pdfOutline,
  annotations,
  onAnnotationJump,
  onDeleteAnnotation,
  onUpdateAnnotation,
  search,
  onSearch,
  onSearchPick,
  tab,
  onTabChange,
  theme,
}: ReaderNavigationProps) {
  const isEpub = book.format === "epub";
  const bookmarks = annotations.filter((annotation) => annotation.kind === "bookmark");
  const highlights = annotations.filter((annotation) => annotation.kind === "highlight");

  const jump = (target: ReaderJump) => {
    onJump(target);
    onOpenChange(false);
  };

  const jumpToChapter = (href: string) => {
    jump(epubHrefJump(href));
  };

  const jumpToOutlinePage = (page: number) => {
    jump({ format: "pdf", page });
  };

  const jumpToAnnotation = (annotation: Annotation) => {
    onAnnotationJump(annotation);
    onOpenChange(false);
  };

  const bookmarkLabel = (annotation: Annotation): string => {
    if (annotation.pageNumber !== null) return `Page ${annotation.pageNumber}`;
    if (annotation.chapterHref) {
      return tocLabelFor(epubToc, annotation.chapterHref) ?? annotation.chapterHref;
    }
    return "Bookmark";
  };

  const highlightLabel = (annotation: Annotation): string => {
    if (annotation.pageNumber !== null) return `Page ${annotation.pageNumber}`;
    if (annotation.chapterHref) {
      return tocLabelFor(epubToc, annotation.chapterHref) ?? "Highlight";
    }
    return "Highlight";
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-testid="reader-nav"
        side="left"
        className="flex w-80 flex-col gap-0 p-0"
        // Focus must stay on the reading surface when the drawer opens (from
        // the toolbar or a shortcut), so arrows and space keep turning pages
        // instead of being captured by the drawer's tabs. The modal focus
        // trap still reaches the tray on the next Tab.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Portaled outside the reader root: redefine the app tokens in the
        // sheet's scope so it follows the reader theme instead of the global
        // light/dark mode (same treatment as the appearance popover).
        style={readerPopoverVariables(epubSurfaceTheme(theme))}
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>{book.title}</SheetTitle>
          <SheetDescription className="sr-only">Reading navigation</SheetDescription>
        </SheetHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value as ReaderNavTab)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList className="w-full justify-start rounded-none border-b bg-transparent px-2">
            {isEpub && navTabTrigger("contents", tab === "contents")}
            {!isEpub && navTabTrigger("pages", tab === "pages")}
            {!isEpub && navTabTrigger("outline", tab === "outline")}
            {navTabTrigger("bookmarks", tab === "bookmarks")}
            {navTabTrigger("highlights", tab === "highlights")}
            {navTabTrigger("search", tab === "search")}
          </TabsList>

          {isEpub && (
            <TabsContent value="contents" className="min-h-0 flex-1 px-2 py-2">
              <ScrollArea className="h-full pr-2">
                {epubToc === null && (
                  <p className="px-2 py-1 text-sm text-[var(--reader-chrome-muted,var(--muted-foreground))]">
                    Loading contents…
                  </p>
                )}
                {epubToc !== null &&
                  flattenToc(epubToc).map(({ item, depth }, index) => (
                    <button
                      key={`${item.href}-${index}`}
                      type="button"
                      data-testid={`toc-item-${index}`}
                      onClick={() => jumpToChapter(item.href)}
                      style={{ paddingLeft: `${8 + depth * 16}px` }}
                      className="block w-full max-w-full truncate rounded-md py-1.5 pr-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {item.label || item.href}
                    </button>
                  ))}
                {epubToc !== null && epubToc.length === 0 && (
                  <p className="px-2 py-1 text-sm text-[var(--reader-chrome-muted,var(--muted-foreground))]">
                    This book has no contents entries.
                  </p>
                )}
                <ScrollBar />
              </ScrollArea>
            </TabsContent>
          )}

          {!isEpub && (
            <>
              <TabsContent value="pages" className="min-h-0 flex-1 px-4 py-3">
                <ScrollArea className="h-full">
                  {pageCount === 0 ? (
                    <p
                      data-testid="nav-pages-loading"
                      className="text-sm text-[var(--reader-chrome-muted,var(--muted-foreground))]"
                    >
                      Loading pages…
                    </p>
                  ) : (
                    <div data-testid="nav-pages" className="grid grid-cols-4 gap-2">
                      {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
                        <button
                          key={page}
                          type="button"
                          data-testid={`nav-page-${page}`}
                          aria-label={`Go to page ${page}`}
                          onClick={() => jump({ format: "pdf", page })}
                          className="rounded-md border py-2 text-sm tabular-nums outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          {page}
                        </button>
                      ))}
                    </div>
                  )}
                  <ScrollBar />
                </ScrollArea>
              </TabsContent>
              <TabsContent
                data-testid="nav-outline"
                value="outline"
                className="min-h-0 flex-1 px-2 py-2"
              >
                <ScrollArea className="h-full pr-2">
                  {pdfOutline === null && (
                    <p className="px-2 py-1 text-sm text-[var(--reader-chrome-muted,var(--muted-foreground))]">
                      Loading outline…
                    </p>
                  )}
                  {pdfOutline !== null && pdfOutline.length === 0 && (
                    <p
                      data-testid="nav-outline-empty"
                      className="px-2 py-1 text-sm text-[var(--reader-chrome-muted,var(--muted-foreground))]"
                    >
                      This document has no outline.
                    </p>
                  )}
                  {pdfOutline !== null &&
                    pdfOutline.length > 0 &&
                    flattenOutline(pdfOutline).map(({ item, depth }, index) =>
                      item.page === null ? (
                        <p
                          key={`${item.title}-${index}`}
                          style={{ paddingLeft: `${8 + depth * 16}px` }}
                          className="block max-w-full truncate px-2 py-1.5 text-sm text-[var(--reader-chrome-muted,var(--muted-foreground))]"
                        >
                          {item.title}
                        </p>
                      ) : (
                        <button
                          key={`${item.title}-${index}`}
                          type="button"
                          data-testid={`nav-outline-item-${index}`}
                          onClick={() => jumpToOutlinePage(item.page as number)}
                          style={{ paddingLeft: `${8 + depth * 16}px` }}
                          className="block w-full max-w-full truncate rounded-md py-1.5 pr-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          {item.title}
                        </button>
                      ),
                    )}
                  <ScrollBar />
                </ScrollArea>
              </TabsContent>
            </>
          )}

          <TabsContent value="bookmarks" className="min-h-0 flex-1 px-2 py-2">
            {bookmarks.length === 0 ? (
              <p
                data-testid="nav-bookmarks-empty"
                className="px-1 py-1 text-sm text-[var(--reader-chrome-muted,var(--muted-foreground))]"
              >
                No bookmarks yet. Press the bookmark action to mark the current position.
              </p>
            ) : (
              <ReaderAnnotationList
                annotations={bookmarks}
                withColor={false}
                label={bookmarkLabel}
                onJump={jumpToAnnotation}
                onDelete={onDeleteAnnotation}
                onUpdate={onUpdateAnnotation}
                testIdPrefix="nav-bookmark"
              />
            )}
          </TabsContent>

          <TabsContent value="highlights" className="min-h-0 flex-1 px-2 py-2">
            {highlights.length === 0 ? (
              <p
                data-testid="nav-highlights-empty"
                className="px-1 py-1 text-sm text-[var(--reader-chrome-muted,var(--muted-foreground))]"
              >
                No highlights yet. Select text in the book and pick a color.
              </p>
            ) : (
              <ReaderAnnotationList
                annotations={highlights}
                withColor
                label={highlightLabel}
                onJump={jumpToAnnotation}
                onDelete={onDeleteAnnotation}
                onUpdate={onUpdateAnnotation}
                testIdPrefix="nav-highlight"
              />
            )}
          </TabsContent>

          <TabsContent value="search" className="min-h-0 flex-1 overflow-hidden">
            <ReaderSearchTab search={search} onSearch={onSearch} onPickMatch={onSearchPick} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
