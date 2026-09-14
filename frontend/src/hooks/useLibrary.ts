import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  getLibraryStats,
  listBooks,
  listCollections,
  onImportProgress,
  onLibraryChanged,
  type Book,
  type CollectionSummary,
  type LibraryStats,
} from "@/lib/bridge";

export interface LibraryState {
  stats: LibraryStats | null;
  books: Book[];
  /** Every collection with its member book ids; empty until first fetched. */
  collections: CollectionSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Re-fetch collections after a membership or grouping change. */
  refreshCollections: () => Promise<void>;
}

/**
 * Window in which backend book events are coalesced into one React commit.
 * A bulk import pushes one event per book — thousands per second at issue
 * #61 scale; the UI only needs the latest state per flush tick.
 */
export const EVENT_FLUSH_MS = 150;

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fetchLibrary(): Promise<{ stats: LibraryStats; books: Book[] }> {
  return Promise.all([getLibraryStats(), listBooks()]).then(([stats, books]) => ({
    stats,
    books,
  }));
}

type PendingChange = { kind: "upsert"; book: Book } | { kind: "removed"; bookId: number };

/**
 * Fetches the library. Used by `LibraryDataProvider` so every consumer
 * (library view, global search, import status) shares one copy of the data
 * and sees refreshes after imports.
 *
 * Live updates (import-progress / library-changed) are buffered and flushed
 * at most once per `EVENT_FLUSH_MS` into a single commit. Patching is O(1)
 * per change through an id→index map: updates replace in place, inserts
 * append unsorted (the completing refresh restores title order), removals
 * rebuild the map (rare).
 */
export function useLibraryData(): LibraryState {
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mirrors of `books` so the flush can patch imperatively without a
  // functional updater (whose double-invocation under StrictMode would
  // corrupt a map maintained as a side effect).
  const booksRef = useRef<Book[]>([]);
  const indexRef = useRef<Map<number, number>>(new Map());
  const pendingRef = useRef<PendingChange[]>([]);
  const flushTimerRef = useRef<number | null>(null);

  const applyFetched = useCallback((next: Book[]) => {
    booksRef.current = next;
    indexRef.current = new Map(next.map((book, index) => [book.id, index]));
    setBooks(next);
  }, []);

  const flushPending = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];

    // Collapse the batch first: for each id the chronologically last event
    // wins (an upsert after a removal resurrects, and vice versa).
    const upserts = new Map<number, Book>();
    const removedIds = new Set<number>();
    for (const change of pending) {
      if (change.kind === "upsert") {
        upserts.set(change.book.id, change.book);
        removedIds.delete(change.book.id);
      } else {
        upserts.delete(change.bookId);
        removedIds.add(change.bookId);
      }
    }

    let next = booksRef.current;
    let mutated = false;
    const edit = (): void => {
      if (!mutated) {
        next = next.slice();
        mutated = true;
      }
    };
    for (const [id, book] of upserts) {
      const index = indexRef.current.get(id);
      if (index !== undefined && next[index]?.id === id) {
        edit();
        next[index] = book;
      } else {
        // Unknown or stale index: linear fallback (a stale map is only
        // possible right after a wholesale fetch replaced the array).
        const found = next.findIndex((candidate) => candidate.id === id);
        edit();
        if (found !== -1) next[found] = book;
        else next.push(book);
      }
    }
    if (removedIds.size > 0) {
      next = next.filter((book) => !removedIds.has(book.id));
      setStats((prev) =>
        prev === null
          ? prev
          : { ...prev, bookCount: Math.max(0, prev.bookCount - removedIds.size) },
      );
    }

    // Single ref write per flush: the fresh id→index map for the next
    // batch (O(n) rebuild is trivial against the O(1) per-change lookups
    // it buys between flushes).
    booksRef.current = next;
    indexRef.current = new Map(next.map((book, index) => [book.id, index]));
    setBooks(next);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushPending();
    }, EVENT_FLUSH_MS);
  }, [flushPending]);

  const fetchCollections = useCallback(
    () =>
      listCollections()
        .then(setCollections)
        .catch((err) => console.error("list_collections failed:", toMessage(err))),
    [],
  );

  const refreshCollections = useCallback(async () => {
    await fetchCollections();
  }, [fetchCollections]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchLibrary();
      setStats(next.stats);
      applyFetched(next.books);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setLoading(false);
    }
  }, [applyFetched]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchLibrary();
        if (cancelled) return;
        setStats(next.stats);
        applyFetched(next.books);
      } catch (err) {
        if (cancelled) return;
        setError(toMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void fetchCollections();
    return () => {
      cancelled = true;
    };
  }, [applyFetched, fetchCollections]);

  // Imports stream one event per persisted book (throttled batches from
  // the sidecar are also flattened here); buffered events land as one
  // commit per flush tick so books and covers appear while the scan is
  // still running. The final refresh after the import completes
  // reconciles ordering and stats (the sidebar count lags a few seconds
  // by design).
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onImportProgress((book) => {
      if (disposed) return;
      pendingRef.current.push({ kind: "upsert", book });
      scheduleFlush();
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => console.error("import-progress subscription failed:", err));
    return () => {
      disposed = true;
      unlisten?.();
      pendingRef.current = [];
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [scheduleFlush]);

  // Filesystem synchronization (milestone 3): the watcher pushes book
  // changes (new/updated/relinked/unavailable) and removals live, so the
  // library view tracks the folder without any polling or manual rescan.
  // Shares the same flush window as import events.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onLibraryChanged((change) => {
      if (disposed) return;
      pendingRef.current.push(
        change.kind === "changed"
          ? { kind: "upsert", book: change.book }
          : { kind: "removed", bookId: change.bookId },
      );
      scheduleFlush();
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => console.error("library-changed subscription failed:", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [scheduleFlush]);

  return { stats, books, collections, loading, error, refresh, refreshCollections };
}

export const LibraryDataContext = createContext<LibraryState | null>(null);

export function useLibrary(): LibraryState {
  const library = useContext(LibraryDataContext);
  if (!library) {
    throw new Error("useLibrary must be used within LibraryDataProvider");
  }
  return library;
}
