import { useCallback, useEffect, useRef, useState } from "react";
import { BookMarked, Link2, RotateCcw, Search, Trash2 } from "lucide-react";
import { ForgetBookDialog } from "@/components/books/ForgetBookDialog";
import { ResetBookDialog } from "@/components/books/ResetBookDialog";
import { RestoreBookDialog } from "@/components/books/RestoreBookDialog";
import { BookCover } from "@/components/books/BookCover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useLibrary } from "@/hooks/useLibrary";
import { providerLinkLabel } from "@/lib/providers";
import {
  forgetBook,
  forgetBooks,
  listBookTrash,
  onImportProgress,
  onLibraryChanged,
  pickBookFile,
  relinkBook,
  listReadingHistory,
  resetBookReadingData,
  restoreBook,
  type BookTrashEntry,
  type ReadingHistoryBook,
  type RestoreConflict,
  type RestoreMode,
} from "@/lib/bridge";

/** A durable book with no file rows; the search is scoped to this view. */
const SEARCH_DEBOUNCE_MS = 150;

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function displayTitle(book: Pick<ReadingHistoryBook, "title">): string {
  const title = book.title?.trim();
  return title === undefined || title === "" ? "Unknown title" : title;
}

function displayAuthor(book: Pick<ReadingHistoryBook, "author">): string {
  const author = book.author?.trim();
  return author === undefined || author === "" ? "Unknown author" : author;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(iso));
}

interface HistoryBookRowProps {
  book: ReadingHistoryBook;
  busy: boolean;
  selected: boolean;
  onToggle: (bookId: number, selected: boolean) => void;
  onRelink: (bookId: number) => void;
  onReset: (book: ReadingHistoryBook) => void;
  onForget: (book: ReadingHistoryBook) => void;
}

function HistoryBookRow({
  book,
  busy,
  selected,
  onToggle,
  onRelink,
  onReset,
  onForget,
}: HistoryBookRowProps) {
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
      <Checkbox
        data-testid={`reading-history-select-${book.id}`}
        aria-label={`Select ${displayTitle(book)}`}
        checked={selected}
        onCheckedChange={(checked) => onToggle(book.id, checked === true)}
      />
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
          {(book.providerLinks ?? []).map((link) => (
            <span key={`${link.provider}:${link.remoteId}`} data-testid="reading-history-provider">
              {providerLinkLabel(link)}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <Button
          data-testid={`reading-history-reset-${book.id}`}
          aria-label={`Reset reading data for ${displayTitle(book)}`}
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onReset(book)}
        >
          <RotateCcw data-icon="inline-start" />
          Reset…
        </Button>
        <Button
          data-testid={`reading-history-forget-${book.id}`}
          aria-label={`Forget ${displayTitle(book)}`}
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onForget(book)}
        >
          <Trash2 data-icon="inline-start" />
          Forget…
        </Button>
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
      </div>
    </li>
  );
}

interface ForgottenBookRowProps {
  entry: BookTrashEntry;
  busy: boolean;
  onRestore: (entry: BookTrashEntry) => void;
}

function ForgottenBookRow({ entry, busy, onRestore }: ForgottenBookRowProps) {
  const progress =
    entry.progressPercent === null
      ? "No progress"
      : `${Math.round(entry.progressPercent)}% progress`;
  return (
    <li
      data-testid="book-trash-entry"
      className="flex items-center justify-between gap-4 rounded-lg border border-dashed p-3"
    >
      <div className="min-w-0">
        <h3 className="truncate font-medium">{displayTitle(entry)}</h3>
        <p className="truncate text-sm text-muted-foreground">{displayAuthor(entry)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {progress} · {entry.annotationCount}{" "}
          {entry.annotationCount === 1 ? "annotation" : "annotations"} · forgotten{" "}
          {formatDate(entry.deletedAt)} · restorable until {formatDate(entry.expiresAt)}
        </p>
        {entry.hasNewState ? (
          <p data-testid="book-trash-new-state" className="mt-1 text-xs text-muted-foreground">
            The current book has new reading data; restoring asks what to do.
          </p>
        ) : null}
      </div>
      <Button
        data-testid={`book-trash-restore-${entry.id}`}
        aria-label={`Restore ${displayTitle(entry)}`}
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => onRestore(entry)}
      >
        <RotateCcw data-icon="inline-start" />
        Restore
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
          : "When a book leaves your watched folders, TuxBooks keeps its progress, annotations, collections, and metadata here. Relink a file and the book returns to the library with that reading history intact. Forgotten books stay restorable for 30 days."}
      </p>
    </div>
  );
}

function ReadingHistorySkeleton() {
  return (
    <div data-testid="reading-history-loading" role="status" aria-label="Loading reading history">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 rounded-lg border p-3">
          <Skeleton className="size-4 rounded" />
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
 * count, searches through the same FTS index as the library, relinks a chosen
 * file, offers single and bulk Forget, and lists the books still restorable
 * from the 30-day trash.
 */
export function ReadingHistoryView() {
  const { refresh } = useLibrary();
  const [books, setBooks] = useState<ReadingHistoryBook[] | null>(null);
  const [trash, setTrash] = useState<BookTrashEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [resetTarget, setResetTarget] = useState<ReadingHistoryBook | null>(null);
  const [forgetTargets, setForgetTargets] = useState<number[] | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BookTrashEntry | null>(null);
  const [restoreConflict, setRestoreConflict] = useState<RestoreConflict | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const requestRef = useRef(0);
  const queryRef = useRef("");

  const load = useCallback(async (search: string) => {
    const request = ++requestRef.current;
    try {
      const found = await listReadingHistory(search);
      if (request === requestRef.current) {
        setBooks(found);
        setSelected((current) => current.filter((id) => found.some((book) => book.id === id)));
        setError(null);
      }
    } catch (err) {
      if (request === requestRef.current) setError(toMessage(err));
    }
  }, []);

  const loadTrash = useCallback(async () => {
    try {
      setTrash(await listBookTrash());
    } catch (err) {
      setError(toMessage(err));
    }
  }, []);

  useEffect(() => {
    queryRef.current = query.trim();
    const timer = window.setTimeout(() => {
      void load(queryRef.current);
      void loadTrash();
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, load, loadTrash]);

  // A book leaving the library arrives here; a relink or a re-import makes it
  // leave this view. Keep the list and the trash live without polling.
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
      if (!disposed) {
        void load(queryRef.current);
        void loadTrash();
      }
    };
    subscribe(onLibraryChanged(reload));
    subscribe(onImportProgress(reload));
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [load, loadTrash]);

  const relink = useCallback(
    async (bookId: number) => {
      const path = await pickBookFile();
      if (path === null || path.trim() === "") return;
      setBusyId(bookId);
      setError(null);
      try {
        await relinkBook(bookId, path);
        await Promise.all([refresh(), load(queryRef.current), loadTrash()]);
      } catch (err) {
        setError(toMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [refresh, load, loadTrash],
  );

  const confirmReset = useCallback(async () => {
    const target = resetTarget;
    setResetTarget(null);
    if (target === null) return;
    setBusyId(target.id);
    setError(null);
    try {
      await resetBookReadingData(target.id);
      await Promise.all([refresh(), load(queryRef.current), loadTrash()]);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusyId(null);
    }
  }, [resetTarget, refresh, load, loadTrash]);

  const confirmForget = useCallback(async () => {
    const targets = forgetTargets;
    setForgetTargets(null);
    if (targets === null || targets.length === 0) return;
    const [first] = targets;
    if (first === undefined) return;
    setBusyId(first);
    setError(null);
    try {
      if (targets.length === 1) await forgetBook(first);
      else await forgetBooks(targets);
      setSelected([]);
      await Promise.all([refresh(), load(queryRef.current), loadTrash()]);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusyId(null);
    }
  }, [forgetTargets, refresh, load, loadTrash]);

  const runRestore = useCallback(
    async (entry: BookTrashEntry, mode?: RestoreMode) => {
      setRestoreBusy(true);
      setError(null);
      try {
        const outcome = await restoreBook(entry.id, mode);
        if (outcome.status === "conflict") {
          setRestoreTarget(entry);
          setRestoreConflict(outcome.conflict);
          return;
        }
        setRestoreTarget(null);
        setRestoreConflict(null);
        await Promise.all([refresh(), load(queryRef.current), loadTrash()]);
      } catch (err) {
        setError(toMessage(err));
      } finally {
        setRestoreBusy(false);
      }
    },
    [refresh, load, loadTrash],
  );

  const toggleSelected = useCallback((bookId: number, next: boolean) => {
    setSelected((current) =>
      next ? [...new Set([...current, bookId])] : current.filter((id) => id !== bookId),
    );
  }, []);

  const allSelected = books !== null && books.length > 0 && selected.length === books.length;
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
        <div className="flex flex-wrap items-center gap-2">
          {count > 0 ? (
            <>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  data-testid="reading-history-select-all"
                  aria-label="Select all Reading history books"
                  checked={allSelected}
                  onCheckedChange={(checked) =>
                    setSelected(checked === true ? (books ?? []).map((book) => book.id) : [])
                  }
                />
                Select all
              </label>
              <Button
                data-testid="reading-history-forget-selected"
                variant="destructive"
                size="sm"
                disabled={selected.length === 0 || busyId !== null}
                onClick={() => setForgetTargets(selected)}
              >
                <Trash2 data-icon="inline-start" />
                Forget selected{selected.length > 0 ? ` (${selected.length})` : ""}
              </Button>
            </>
          ) : null}
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
        </div>
      </header>

      {error !== null ? (
        <div
          data-testid="reading-history-error"
          role="alert"
          className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-4"
        >
          <p className="font-medium">Could not update Reading history</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              void load(queryRef.current);
              void loadTrash();
            }}
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
              selected={selected.includes(book.id)}
              onToggle={toggleSelected}
              onRelink={(bookId) => void relink(bookId)}
              onReset={(target) => setResetTarget(target)}
              onForget={(target) => setForgetTargets([target.id])}
            />
          ))}
        </ul>
      )}

      {trash.length > 0 ? (
        <section data-testid="recently-forgotten" className="mt-8">
          <h3 className="text-lg font-semibold">Recently forgotten</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Forgotten books stay restorable for 30 days. Restoring puts the old record and its state
            back; if the current book has new reading data, TuxBooks asks first.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {trash.map((entry) => (
              <ForgottenBookRow
                key={entry.id}
                entry={entry}
                busy={restoreBusy}
                onRestore={(target) => void runRestore(target)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <ResetBookDialog
        open={resetTarget !== null}
        title={resetTarget?.title ?? undefined}
        onConfirm={() => void confirmReset()}
        onCancel={() => setResetTarget(null)}
      />
      <ForgetBookDialog
        open={forgetTargets !== null}
        count={forgetTargets?.length ?? 0}
        keepsFile={false}
        onConfirm={() => void confirmForget()}
        onCancel={() => setForgetTargets(null)}
      />
      <RestoreBookDialog
        open={restoreTarget !== null && restoreConflict !== null}
        entry={restoreTarget}
        conflict={restoreConflict}
        busy={restoreBusy}
        onChoose={(mode) => {
          if (restoreTarget) void runRestore(restoreTarget, mode);
        }}
        onCancel={() => {
          setRestoreTarget(null);
          setRestoreConflict(null);
        }}
      />
    </section>
  );
}
