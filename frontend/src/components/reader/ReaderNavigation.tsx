import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getBookToc } from "@/lib/tauri";
import { useReader } from "@/state/readerState";
import type { Book } from "@/types/domain";

interface ReaderNavigationProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  book: Book;
  pageCount: number;
  onJump: (percentage: number) => void;
}

/** TOC entries are EPUB spine hrefs like `text/chapter1.xhtml`. */
function chapterLabel(href: string): string {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // keep the raw href when it is not valid percent-encoding
  }
  const base = decoded.split("/").pop() ?? decoded;
  const label = base
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return label || base;
}

/**
 * Reading navigation drawer. EPUB contents come from the real
 * `get_book_toc` command; PDF pages are derived from the placeholder
 * document; outlines and bookmark persistence are honest placeholders
 * until their engines/backend exist.
 */
export function ReaderNavigation({
  open,
  onOpenChange,
  book,
  pageCount,
  onJump,
}: ReaderNavigationProps) {
  const isEpub = book.format === "epub";
  const { bookmarks } = useReader();
  const [toc, setToc] = useState<string[] | null>(null);
  const [tocError, setTocError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    // Clear on close so the next open starts from the loading state; the
    // fetch effect itself never sets state synchronously.
    if (!next) {
      setToc(null);
      setTocError(null);
    }
    onOpenChange(next);
  };

  useEffect(() => {
    if (!open || !isEpub) return;
    let cancelled = false;
    getBookToc(book.id)
      .then((toc) => {
        if (!cancelled) setToc(toc.chapters);
      })
      .catch((err: unknown) => {
        if (!cancelled) setTocError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, isEpub, book.id]);

  const jump = (percentage: number) => {
    onJump(percentage);
    handleOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
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
                {tocError && (
                  <p
                    data-testid="toc-error"
                    role="alert"
                    className="px-2 py-1 text-sm text-muted-foreground"
                  >
                    Contents could not be loaded: {tocError}
                  </p>
                )}
                {!tocError && toc === null && (
                  <p className="px-2 py-1 text-sm text-muted-foreground">Loading contents…</p>
                )}
                {toc?.map((href, index) => (
                  <button
                    key={`${href}-${index}`}
                    type="button"
                    data-testid={`toc-item-${index}`}
                    onClick={() => jump(Math.round((index / Math.max(toc.length, 1)) * 100))}
                    className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60"
                  >
                    {chapterLabel(href)}
                  </button>
                ))}
                {toc !== null && toc.length === 0 && (
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
                  <div data-testid="nav-pages" className="grid grid-cols-4 gap-2">
                    {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
                      <button
                        key={page}
                        type="button"
                        data-testid={`nav-page-${page}`}
                        onClick={() =>
                          jump(Math.round(((page - 1) / Math.max(pageCount - 1, 1)) * 100))
                        }
                        className="rounded-md border py-2 text-sm tabular-nums hover:bg-accent/60"
                      >
                        {page}
                      </button>
                    ))}
                  </div>
                  <ScrollBar />
                </ScrollArea>
              </TabsContent>
              <TabsContent value="outline" className="min-h-0 flex-1 px-4 py-3">
                <p data-testid="nav-outline" className="text-sm text-muted-foreground">
                  Outlines arrive with the real PDF renderer — there is nothing to show yet.
                </p>
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
                    className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60"
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
