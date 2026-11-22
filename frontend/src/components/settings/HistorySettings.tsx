import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, Search, Trash2 } from "lucide-react";
import { ForgetBookDialog } from "@/components/books/ForgetBookDialog";
import { ResetBookDialog } from "@/components/books/ResetBookDialog";
import { RestoreBookDialog } from "@/components/books/RestoreBookDialog";
import { ForgottenBookRow, HistoryBookRow } from "@/components/history/ReadingHistoryRows";
import { useHistoryVirtualizer } from "@/components/history/useHistoryVirtualizer";
import { VirtualRow } from "@/components/library/LibraryRow";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EVENT_FLUSH_MS, useLibrary } from "@/hooks/useLibrary";
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

/** The search is scoped to detached records, so it debounces like the library. */
const SEARCH_DEBOUNCE_MS = 150;

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function EmptyDetachedRecords({ searching }: { searching: boolean }) {
  return (
    <div
      data-testid="history-empty"
      className="flex h-64 flex-col items-center justify-center gap-3 text-center"
    >
      <BookMarked aria-hidden="true" className="h-12 w-12 text-muted-foreground" />
      <h3 className="text-lg font-semibold">
        {searching ? "No books match that search" : "No detached records"}
      </h3>
      <p className="max-w-md text-sm text-muted-foreground">
        {searching
          ? "Detached records only cover books whose file is no longer in a watched folder."
          : "When a book leaves your watched folders, TuxBooks keeps its progress, annotations, collections, and metadata here. Relink a file and the book returns to the library with that reading history intact."}
      </p>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div data-testid="history-loading" role="status" aria-label="Loading history">
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

function EmptyForgottenBooks() {
  return (
    <p data-testid="history-forgotten-empty" className="text-sm text-muted-foreground">
      Nothing is waiting to be restored. Forgotten books appear here and stay restorable for 30
      days.
    </p>
  );
}

/**
 * The History section (ADR 0014 D6): durable books with no current file, plus
 * the 30-day restore list. The library stays membership-only, so this is the
 * only surface that shows detached records. It reads the durable metadata
 * snapshot plus the live progress and annotation count, searches through the
 * same FTS index as the library, relinks a chosen file, offers single and
 * bulk Forget, and restores forgotten books from the trash.
 *
 * Both tabs share one load loop and one set of dialogs, so forgetting on one
 * tab refreshes the other without a remount.
 */
export function HistorySettings() {
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

  // Set membership keeps per-row selection checks O(n), not O(n²).
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // The DOM holds the visible window plus overscan, never one node per book.
  const { attachScroller, virtualizer, virtualRows, unvirtualized, fallbackRowCount } =
    useHistoryVirtualizer(books?.length ?? 0, (index) => `history-${books?.[index]?.id ?? index}`);

  const load = useCallback(async (search: string) => {
    const request = ++requestRef.current;
    try {
      const found = await listReadingHistory(search);
      if (request === requestRef.current) {
        setBooks(found);
        const foundIds = new Set(found.map((book) => book.id));
        setSelected((current) => current.filter((id) => foundIds.has(id)));
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

  // Bulk Forget emits one event per book: coalesce reloads per flush window so
  // a 10,000-book forget cannot stall the sidecar's write loop.
  useEffect(() => {
    let disposed = false;
    let reloadTimer: number | null = null;
    const unlisteners: (() => void)[] = [];
    const subscribe = (listen: Promise<() => void>) => {
      void listen
        .then((fn) => {
          if (disposed) fn();
          else unlisteners.push(fn);
        })
        .catch((err) => console.error("history subscription failed:", err));
    };
    const scheduleReload = () => {
      if (reloadTimer !== null) return;
      reloadTimer = window.setTimeout(() => {
        reloadTimer = null;
        if (!disposed) {
          void load(queryRef.current);
          void loadTrash();
        }
      }, EVENT_FLUSH_MS);
    };
    subscribe(onLibraryChanged(scheduleReload));
    subscribe(onImportProgress(scheduleReload));
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
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
      // A chunked forget leaves earlier chunks forgotten; reload actual state.
      await Promise.all([refresh(), load(queryRef.current), loadTrash()]);
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

  const renderHistoryRow = (book: ReadingHistoryBook) => (
    <HistoryBookRow
      book={book}
      busy={busyId === book.id}
      selected={selectedSet.has(book.id)}
      onToggle={toggleSelected}
      onRelink={(bookId) => void relink(bookId)}
      onReset={(target) => setResetTarget(target)}
      onForget={(target) => setForgetTargets([target.id])}
    />
  );

  return (
    <div data-testid="settings-rows" className="mt-6 flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Books whose files left your watched folders keep their reading state as detached records.
        Relink a file to return a record to the library; forget a record to clear it after a 30-day
        restorable window.
      </p>

      <Tabs defaultValue="detached">
        <TabsList>
          <TabsTrigger value="detached" data-testid="history-tab-detached">
            Detached records
          </TabsTrigger>
          <TabsTrigger value="forgotten" data-testid="history-tab-forgotten">
            Forgotten books
          </TabsTrigger>
        </TabsList>

        {/* Both panes stay mounted: one load loop feeds them, and a forget on
            either side is reflected on the other without a refetch-on-switch. */}
        <TabsContent value="detached" forceMount className="mt-4">
          <section data-testid="history-settings-view" className="flex min-h-0 flex-col">
            <header className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
              <p data-testid="history-count" className="text-sm text-muted-foreground">
                {count} {count === 1 ? "record" : "records"}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {count > 0 ? (
                  <>
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Checkbox
                        data-testid="history-select-all"
                        aria-label="Select all detached records"
                        checked={allSelected}
                        onCheckedChange={(checked) =>
                          setSelected(checked === true ? (books ?? []).map((book) => book.id) : [])
                        }
                      />
                      Select all
                    </label>
                    <Button
                      data-testid="history-forget-selected"
                      variant="destructive"
                      size="sm"
                      disabled={selected.length === 0 || busyId !== null}
                      onClick={() => setForgetTargets(selected)}
                    >
                      <Trash2 data-icon="inline-start" />
                      Forget selected{selected.length > 0 ? ` (${selected.length})` : ""}…
                    </Button>
                  </>
                ) : null}
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    data-testid="history-search"
                    aria-label="Search detached records"
                    type="search"
                    placeholder="Search detached records"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="w-64 pl-8"
                  />
                </div>
              </div>
            </header>

            {error !== null ? (
              <div
                data-testid="history-error"
                role="alert"
                className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-4"
              >
                <p className="font-medium">Could not update history</p>
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
              <HistorySkeleton />
            ) : books.length === 0 ? (
              <EmptyDetachedRecords searching={searching} />
            ) : (
              <div
                ref={attachScroller}
                data-testid="history-scroller"
                className="max-h-96 min-h-0 overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable]"
              >
                {unvirtualized ? (
                  // No geometry yet (jsdom tests, SSR): bounded static slice, not the real render.
                  <div className="flex flex-col gap-2">
                    {books.slice(0, fallbackRowCount).map((book) => (
                      <Fragment key={book.id}>{renderHistoryRow(book)}</Fragment>
                    ))}
                  </div>
                ) : (
                  <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                    {virtualRows.map((virtualRow) => {
                      const book = books[virtualRow.index];
                      if (book === undefined) return null;
                      return (
                        <VirtualRow
                          key={virtualRow.key}
                          index={virtualRow.index}
                          start={virtualRow.start}
                          measure={virtualizer.measureElement}
                        >
                          <div className="pb-2">{renderHistoryRow(book)}</div>
                        </VirtualRow>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        </TabsContent>

        <TabsContent value="forgotten" forceMount className="mt-4">
          <section data-testid="recently-forgotten" className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Forgotten books stay restorable for 30 days. Restoring puts the old record and its
              state back; if the current book has new reading data, TuxBooks asks first.
            </p>
            {trash.length === 0 ? (
              <EmptyForgottenBooks />
            ) : (
              <ul className="flex flex-col gap-2">
                {trash.map((entry) => (
                  <ForgottenBookRow
                    key={entry.id}
                    entry={entry}
                    busy={restoreBusy}
                    onRestore={(target) => void runRestore(target)}
                  />
                ))}
              </ul>
            )}
          </section>
        </TabsContent>
      </Tabs>

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
    </div>
  );
}
