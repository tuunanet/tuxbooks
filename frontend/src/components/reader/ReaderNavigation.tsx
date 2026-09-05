import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EpubTocItem } from "@/lib/epub/epubEngine";
import type { PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import type { Annotation, AnnotationPatch } from "@/types/domain";
import type { Book } from "@/types/domain";
import type { ReaderJump } from "./readerModel";
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
 * Reading navigation drawer: EPUB contents from the foliate-js engine (real
 * labels, real destinations); PDF pages, thumbnails, and outline from the
 * loaded PDF.js document; persistent bookmarks, highlights, and notes from
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
}: ReaderNavigationProps) {
  const isEpub = book.format === "epub";
  const bookmarks = annotations.filter((annotation) => annotation.kind === "bookmark");
  const highlights = annotations.filter((annotation) => annotation.kind === "highlight");

  const jump = (target: ReaderJump) => {
    onJump(target);
    onOpenChange(false);
  };

  const jumpToChapter = (href: string) => {
    jump({ format: "epub", locator: href });
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
      <SheetContent data-testid="reader-nav" side="left" className="flex w-80 flex-col gap-0 p-0">
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
            {isEpub && (
              <TabsTrigger data-testid="nav-tab-contents" value="contents">
                Contents
              </TabsTrigger>
            )}
            {!isEpub && (
              <>
                <TabsTrigger data-testid="nav-tab-pages" value="pages">
                  Pages
                </TabsTrigger>
                <TabsTrigger data-testid="nav-tab-outline" value="outline">
                  Outline
                </TabsTrigger>
              </>
            )}
            <TabsTrigger data-testid="nav-tab-bookmarks" value="bookmarks">
              Bookmarks
            </TabsTrigger>
            <TabsTrigger data-testid="nav-tab-highlights" value="highlights">
              Highlights
            </TabsTrigger>
            <TabsTrigger data-testid="nav-tab-search" value="search">
              Search
            </TabsTrigger>
          </TabsList>

          {isEpub && (
            <TabsContent value="contents" className="min-h-0 flex-1 px-2 py-2">
              <ScrollArea className="h-full pr-2">
                {epubToc === null && (
                  <p className="px-2 py-1 text-sm text-muted-foreground">Loading contents…</p>
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
                  <p className="px-2 py-1 text-sm text-muted-foreground">
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
                    <p data-testid="nav-pages-loading" className="text-sm text-muted-foreground">
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
                    <p className="px-2 py-1 text-sm text-muted-foreground">Loading outline…</p>
                  )}
                  {pdfOutline !== null && pdfOutline.length === 0 && (
                    <p
                      data-testid="nav-outline-empty"
                      className="px-2 py-1 text-sm text-muted-foreground"
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
                          className="block max-w-full truncate px-2 py-1.5 text-sm text-muted-foreground"
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
                className="px-1 py-1 text-sm text-muted-foreground"
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
                className="px-1 py-1 text-sm text-muted-foreground"
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
