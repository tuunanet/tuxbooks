import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useReader } from "@/state/readerState";
import type { EpubTocItem } from "@/lib/epub/epubEngine";
import type { PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import type { Book } from "@/types/domain";

interface ReaderNavigationProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  book: Book;
  pageCount: number;
  onJump: (percentage: number) => void;
  /** Engine-reported EPUB table of contents; null while the book opens. */
  epubToc: EpubTocItem[] | null;
  /** Navigates the EPUB engine to a TOC destination (href or CFI). */
  onEpubJump: (href: string) => void;
  /** Engine-resolved PDF outline; null while the document opens. */
  pdfOutline: PdfOutlineItem[] | null;
  /** Navigates the PDF reader to an outline entry's page. */
  onPdfJump: (page: number) => void;
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

/**
 * Reading navigation drawer. EPUB contents come from the foliate-js engine
 * (real labels, real destinations); PDF pages, thumbnails, and the outline
 * come from the loaded PDF.js document; bookmark persistence remains an
 * honest session-only placeholder until the backend exists.
 */
export function ReaderNavigation({
  open,
  onOpenChange,
  book,
  pageCount,
  onJump,
  epubToc,
  onEpubJump,
  pdfOutline,
  onPdfJump,
}: ReaderNavigationProps) {
  const isEpub = book.format === "epub";
  const { bookmarks } = useReader();

  const jump = (percentage: number) => {
    onJump(percentage);
    onOpenChange(false);
  };

  const jumpToChapter = (href: string) => {
    onEpubJump(href);
    onOpenChange(false);
  };

  const jumpToOutlinePage = (page: number) => {
    onPdfJump(page);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="reader-nav" side="left" className="flex w-80 flex-col gap-0 p-0">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>{book.title}</SheetTitle>
          <SheetDescription className="sr-only">Reading navigation</SheetDescription>
        </SheetHeader>

        <Tabs
          defaultValue={isEpub ? "contents" : "pages"}
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
                          onClick={() =>
                            jump(Math.round(((page - 1) / Math.max(pageCount - 1, 1)) * 100))
                          }
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
            <ScrollArea className="h-full px-2 pr-2">
              {bookmarks.length === 0 ? (
                <p
                  data-testid="nav-bookmarks-empty"
                  className="px-1 py-1 text-sm text-muted-foreground"
                >
                  No bookmarks yet. Press the bookmark action to mark the current position.
                </p>
              ) : (
                bookmarks.map((bookmark) => (
                  <button
                    key={bookmark.id}
                    type="button"
                    data-testid={`nav-bookmark-${bookmark.percentage}`}
                    onClick={() => jump(bookmark.percentage)}
                    className="block w-full rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {bookmark.label}
                  </button>
                ))
              )}
              <p className="mt-3 px-1 text-xs text-muted-foreground">
                Bookmarks live for this reading session only — saving them needs backend support
                that does not exist yet.
              </p>
              <ScrollBar />
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
