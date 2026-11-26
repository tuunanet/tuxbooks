import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import { ForgetBookDialog } from "@/components/books/ForgetBookDialog";
import { EraseBookDialog } from "@/components/books/EraseBookDialog";
import { ResetBookDialog } from "@/components/books/ResetBookDialog";
import { RestoreBookDialog } from "@/components/books/RestoreBookDialog";
import { RestoreDifferentBytesDialog } from "@/components/books/RestoreDifferentBytesDialog";
import { ForgottenBooksPane } from "@/components/settings/ForgottenBooksPane";
import { EmptyDetachedRecords, HistorySkeleton } from "@/components/settings/HistoryStates";
import { HistoryBookRow } from "@/components/history/ReadingHistoryRows";
import { useHistoryVirtualizer } from "@/components/history/useHistoryVirtualizer";
import { VirtualRow } from "@/components/library/LibraryRow";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EVENT_FLUSH_MS, useLibrary } from "@/hooks/useLibrary";
import {
  eraseBookTrash,
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
  type RestoreDifferentBytes,
  type RestoreMode,
} from "@/lib/bridge";

/** The search is scoped to detached records, so it debounces like the library. */
const SEARCH_DEBOUNCE_MS = 150;

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The History section (ADR 0014 D6). Both tabs share one load loop and one
 * set of dialogs, so forgetting on one tab refreshes the other without a remount.
 */
/** One bundle for the restore flow: the entry, its pick, and either dialog's payload. */
interface RestoreFlow {
  target: BookTrashEntry | null;
  pick: string | undefined;
  conflict: RestoreConflict | null;
  differentBytes: RestoreDifferentBytes | null;
}

const idleRestoreFlow: RestoreFlow = {
  target: null,
  pick: undefined,
  conflict: null,
  differentBytes: null,
};

export function HistorySettings() {
  const { refresh, books: libraryBooks } = useLibrary();
  const [books, setBooks] = useState<ReadingHistoryBook[] | null>(null);
  const [trash, setTrash] = useState<BookTrashEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [resetTarget, setResetTarget] = useState<ReadingHistoryBook | null>(null);
  const [forgetTargets, setForgetTargets] = useState<number[] | null>(null);
  const [restoreFlow, setRestoreFlow] = useState<RestoreFlow>(idleRestoreFlow);
  const [trashBusy, setTrashBusy] = useState(false);
  const [eraseTarget, setEraseTarget] = useState<BookTrashEntry | null>(null);
  const requestRef = useRef(0);
  const queryRef = useRef("");

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
    async (entry: BookTrashEntry, mode?: RestoreMode, pickedPath?: string) => {
      setTrashBusy(true);
      setError(null);
      try {
        const outcome = await restoreBook(entry.id, mode, pickedPath);
        if (outcome.status === "conflict") {
          setRestoreFlow({
            target: entry,
            pick: pickedPath,
            conflict: outcome.conflict,
            differentBytes: null,
          });
          return;
        }
        if (outcome.status === "different_bytes") {
          setRestoreFlow({
            target: entry,
            pick: pickedPath,
            conflict: null,
            differentBytes: outcome.differentBytes,
          });
          return;
        }
        setRestoreFlow(idleRestoreFlow);
        await Promise.all([refresh(), load(queryRef.current), loadTrash()]);
      } catch (err) {
        setError(toMessage(err));
      } finally {
        setTrashBusy(false);
      }
    },
    [refresh, load, loadTrash],
  );

  const restoreFromRow = useCallback(
    async (entry: BookTrashEntry) => {
      if (entry.replacementBookId !== null && entry.replacementHasFile) {
        await runRestore(entry);
        return;
      }
      const pickedPath = await pickBookFile(entry.id);
      if (pickedPath === null) return;
      await runRestore(entry, undefined, pickedPath);
    },
    [runRestore],
  );

  const confirmErase = useCallback(async () => {
    const target = eraseTarget;
    setEraseTarget(null);
    if (target === null) return;
    setTrashBusy(true);
    setError(null);
    try {
      await eraseBookTrash(target.id);
    } catch (err) {
      setError(toMessage(err));
    }
    // The entry is gone on success and still there on failure; show what is real.
    await loadTrash();
    setTrashBusy(false);
  }, [eraseTarget, loadTrash]);

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

        {/* Panes stay mounted (one load loop feeds both); forceMount keeps Radix from hiding them, so the inactive pane hides by class. */}
        <TabsContent value="detached" forceMount className="mt-4 data-[state=inactive]:hidden">
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

        <ForgottenBooksPane
          trash={trash}
          busy={trashBusy}
          onRestore={(target) => void restoreFromRow(target)}
          onErase={(target) => setEraseTarget(target)}
        />
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
      <EraseBookDialog
        open={eraseTarget !== null}
        title={eraseTarget?.title ?? undefined}
        onConfirm={() => void confirmErase()}
        onCancel={() => setEraseTarget(null)}
      />
      <RestoreBookDialog
        open={restoreFlow.target !== null && restoreFlow.conflict !== null}
        entry={restoreFlow.target}
        conflict={restoreFlow.conflict}
        busy={trashBusy}
        onChoose={(mode) => {
          if (restoreFlow.target) void runRestore(restoreFlow.target, mode, restoreFlow.pick);
        }}
        onCancel={() => setRestoreFlow(idleRestoreFlow)}
      />
      <RestoreDifferentBytesDialog
        open={restoreFlow.differentBytes !== null}
        report={restoreFlow.differentBytes}
        ownerTitle={
          restoreFlow.differentBytes?.ownerBookId != null
            ? (libraryBooks?.find((book) => book.id === restoreFlow.differentBytes?.ownerBookId)
                ?.title ?? null)
            : null
        }
        busy={trashBusy}
        onChoose={(mode) => {
          if (restoreFlow.target) void runRestore(restoreFlow.target, mode, restoreFlow.pick);
        }}
        onCancel={() => setRestoreFlow(idleRestoreFlow)}
      />
    </div>
  );
}
