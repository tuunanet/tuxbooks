import { useCallback, useEffect, useRef, useState } from "react";
import { BookMarked, Link2, Search } from "lucide-react";
import { BookCover } from "@/components/books/BookCover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useLibrary } from "@/hooks/useLibrary";
import {
  onImportProgress,
  onLibraryChanged,
  pickBookFile,
  relinkBook,
  listReadingHistory,
  type ReadingHistoryBook,
} from "@/lib/bridge";

/** A durable book with no file rows; the search is scoped to this view. */
const SEARCH_DEBOUNCE_MS = 150;

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function displayTitle(book: ReadingHistoryBook): string {
  const title = book.title?.trim();
  return title === undefined || title === "" ? "Unknown title" : title;
}

function displayAuthor(book: ReadingHistoryBook): string {
  const author = book.author?.trim();
  return author === undefined || author === "" ? "Unknown author" : author;
}

interface HistoryBookRowProps {
  book: ReadingHistoryBook;
  busy: boolean;
  onRelink: (bookId: number) => void;
}

function HistoryBookRow({ book, busy, onRelink }: HistoryBookRowProps) {
  const progress =
    book.progressPercent === null ? "Not started" : `${Math.round(book.progressPercent)}% read`;
  const annotations = `${book.annotationCount} ${
    book.annotationCount === 1 ? "annotation" : "annotations"
  }`;

  return (
    <li
      data-testid="reading-history-book"
      className="flex items-center gap-4 rounded-lg border bg-card p-3"
    >
      <BookCover
        book={{ title: displayTitle(book), coverPath: book.coverPath }}
        className="h-20 w-14 shrink-0"
        initialClassName="text-lg"
      />
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-medium">{displayTitle(book)}</h3>
        <p className="truncate text-sm text-muted-foreground">{displayAuthor(book)}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span data-testid="reading-history-progress">{progress}</span>
          <span data-testid="reading-history-annotations">{annotations}</span>
          {/* Provider link storage lands with ticket tuxbooks-ip6.3. */}
        </div>
      </div>
      <Button
        data-testid={`reading-history-relink-${book.id}`}
        aria-label={`Relink ${displayTitle(book)}`}
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => onRelink(book.id)}
      >
        <Link2 data-icon="inline-start" />
        {busy ? "Relinking…" : "Relink…"}
      </Button>
    </li>
  );
}

function EmptyReadingHistory({ searching }: { searching: boolean }) {
  return (
    <div
      data-testid="reading-history-empty"
      className="flex h-full flex-col items-center justify-center gap-3 text-center"
    >
      <BookMarked aria-hidden="true" className="h-12 w-12 text-muted-foreground" />
      <h2 className="text-xl font-semibold">
        {searching ? "No books match that search" : "No Reading history yet"}
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {searching
          ? "Reading history only searches books whose file is no longer in a watched folder."
          : "When a book leaves your watched folders, TuxBooks keeps its progress, annotations, collections, and metadata here. Relink a file and the book returns to the library with that reading history intact."}
      </p>
    </div>
  );
}

function ReadingHistorySkeleton() {
  return (
    <div data-testid="reading-history-loading" role="status" aria-label="Loading reading history">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 rounded-lg border p-3">
          <Skeleton className="h-20 w-14 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Reading history (ADR 0014 D6): durable books with no current file. The
 * library stays membership-only, so this is the only surface that shows them.
 * It reads the durable metadata snapshot plus the live progress and annotation
 * count, searches through the same FTS index as the library, and relinks a
 * chosen file through the existing native file picker.
 */
export function ReadingHistoryView() {
  const { refresh } = useLibrary();
  const [books, setBooks] = useState<ReadingHistoryBook[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const requestRef = useRef(0);
  const queryRef = useRef("");

  const load = useCallback(async (search: string) => {
    const request = ++requestRef.current;
    try {
      const found = await listReadingHistory(search);
      if (request === requestRef.current) {
        setBooks(found);
        setError(null);
      }
    } catch (err) {
      if (request === requestRef.current) setError(toMessage(err));
    }
  }, []);

  useEffect(() => {
    queryRef.current = query.trim();
    const timer = window.setTimeout(() => {
      void load(queryRef.current);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, load]);

  // A book leaving the library arrives here; a relink or a re-import makes it
  // leave this view. Keep the list live without polling.
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const subscribe = (listen: Promise<() => void>) => {
      void listen
        .then((fn) => {
          if (disposed) fn();
          else unlisteners.push(fn);
        })
        .catch((err) => console.error("reading-history subscription failed:", err));
    };
    const reload = () => {
      if (!disposed) void load(queryRef.current);
    };
    subscribe(onLibraryChanged(reload));
    subscribe(onImportProgress(reload));
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [load]);

  const relink = useCallback(
    async (bookId: number) => {
      const path = await pickBookFile();
      if (path === null || path.trim() === "") return;
      setBusyId(bookId);
      setError(null);
      try {
        await relinkBook(bookId, path);
        await Promise.all([refresh(), load(queryRef.current)]);
      } catch (err) {
        setError(toMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [refresh, load],
  );

  const searching = query.trim() !== "";
  const count = books?.length ?? 0;

  return (
    <section data-testid="reading-history-view" className="flex h-full min-h-0 flex-col">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h2 className="text-2xl font-semibold">Reading history</h2>
          <p data-testid="reading-history-count" className="text-sm text-muted-foreground">
            {count} {count === 1 ? "book" : "books"}
          </p>
        </div>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            data-testid="reading-history-search"
            aria-label="Search reading history"
            type="search"
            placeholder="Search Reading history"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-64 pl-8"
          />
        </div>
      </header>

      {error !== null ? (
        <div
          data-testid="reading-history-error"
          role="alert"
          className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-4"
        >
          <p className="font-medium">Could not load Reading history</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void load(queryRef.current)}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {books === null ? (
        <ReadingHistorySkeleton />
      ) : books.length === 0 ? (
        <EmptyReadingHistory searching={searching} />
      ) : (
        <ul className="flex flex-col gap-2 overflow-y-auto">
          {books.map((book) => (
            <HistoryBookRow
              key={book.id}
              book={book}
              busy={busyId === book.id}
              onRelink={(bookId) => void relink(bookId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
