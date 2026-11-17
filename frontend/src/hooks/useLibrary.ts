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

  // Mirrors of `books`: a functional updater double-invokes under StrictMode and corrupts the map.
  const booksRef = useRef<Book[]>([]);
  const indexRef = useRef<Map<number, number>>(new Map());
  const pendingRef = useRef<PendingChange[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  // Only the newest wholesale fetch applies: an older import refresh must not undo a purge.
  const fetchSeqRef = useRef(0);

  const cancelFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const applyFetched = useCallback(
    (next: Book[]) => {
      // A wholesale fetch supersedes buffered events whose payloads predate this snapshot.
      pendingRef.current = [];
      cancelFlushTimer();
      booksRef.current = next;
      indexRef.current = new Map(next.map((book, index) => [book.id, index]));
      setBooks(next);
    },
    [cancelFlushTimer],
  );

  const flushPending = useCallback(() => {
    cancelFlushTimer();
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];

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
        const found = next.findIndex((candidate) => candidate.id === id);
        edit();
        if (found !== -1) next[found] = book;
        else next.push(book);
      }
    }
    if (removedIds.size > 0) {
      let removedPresent = 0;
      next = next.filter((book) => {
        if (!removedIds.has(book.id)) return true;
        removedPresent += 1;
        return false;
      });
      // Count only removals actually present: a late removal racing a refresh must not lower it.
      if (removedPresent > 0) {
        setStats((prev) =>
          prev === null
            ? prev
            : { ...prev, bookCount: Math.max(0, prev.bookCount - removedPresent) },
        );
      }
    }

    // Single ref write per flush: O(n) rebuild buys O(1) per-change lookups.
    booksRef.current = next;
    indexRef.current = new Map(next.map((book, index) => [book.id, index]));
    setBooks(next);
  }, [cancelFlushTimer]);

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

  const loadLibrary = useCallback(
    async (showLoading: boolean) => {
      const seq = ++fetchSeqRef.current;
      if (showLoading) {
        setLoading(true);
        setError(null);
      }
      try {
        const next = await fetchLibrary();
        if (seq !== fetchSeqRef.current) return;
        setStats(next.stats);
        applyFetched(next.books);
        setError(null);
      } catch (err) {
        if (seq !== fetchSeqRef.current) return;
        if (showLoading) setError(toMessage(err));
        else console.error("library reload failed:", toMessage(err));
      } finally {
        // A quiet reload can supersede an in-flight load whose cleanup is skipped.
        if (seq === fetchSeqRef.current) setLoading(false);
      }
    },
    [applyFetched],
  );

  // A sync identity merge can replace book ids, so refetch quietly instead of patching.
  const reloadFromBackend = useCallback(async () => {
    void fetchCollections();
    await loadLibrary(false);
  }, [fetchCollections, loadLibrary]);

  const refresh = useCallback(async () => {
    await loadLibrary(true);
  }, [loadLibrary]);

  useEffect(() => {
    let cancelled = false;
    const seq = ++fetchSeqRef.current;
    void (async () => {
      try {
        const next = await fetchLibrary();
        if (cancelled || seq !== fetchSeqRef.current) return;
        setStats(next.stats);
        applyFetched(next.books);
      } catch (err) {
        if (cancelled || seq !== fetchSeqRef.current) return;
        setError(toMessage(err));
      } finally {
        if (!cancelled && seq === fetchSeqRef.current) setLoading(false);
      }
    })();
    void fetchCollections();
    return () => {
      cancelled = true;
    };
  }, [applyFetched, fetchCollections]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onImportProgress((batch) => {
      if (disposed) return;
      for (const book of batch.books) {
        pendingRef.current.push({ kind: "upsert", book });
      }
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
      cancelFlushTimer();
    };
  }, [scheduleFlush, cancelFlushTimer]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onLibraryChanged((change) => {
      if (disposed) return;
      if (change.kind === "reload") {
        pendingRef.current = [];
        cancelFlushTimer();
        void reloadFromBackend();
        return;
      }
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
  }, [scheduleFlush, cancelFlushTimer, reloadFromBackend]);

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
