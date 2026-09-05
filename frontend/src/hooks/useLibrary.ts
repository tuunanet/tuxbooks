import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  getLibraryStats,
  listBooks,
  listCollections,
  onImportProgress,
  onLibraryChanged,
  type Book,
  type CollectionSummary,
  type LibraryStats,
} from "@/lib/tauri";

export interface LibraryState {
  stats: LibraryStats | null;
  books: Book[];
  /** Every collection with member book ids; empty until first fetched. */
  collections: CollectionSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Re-fetch collections after a membership or grouping change. */
  refreshCollections: () => Promise<void>;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fetchLibrary(): Promise<{ stats: LibraryStats; books: Book[] }> {
  return Promise.all([getLibraryStats(), listBooks()]).then(([stats, books]) => ({
    stats,
    books,
  }));
}

/** Insert-or-replace a book in the list, keeping title order. */
function patchBook(existing: Book[], book: Book): Book[] {
  const index = existing.findIndex((candidate) => candidate.id === book.id);
  if (index === -1) {
    const next = [...existing, book];
    next.sort((a, b) => a.title.localeCompare(b.title));
    return next;
  }
  const next = [...existing];
  next[index] = book;
  return next;
}

/**
 * Fetches the library. Used by `LibraryDataProvider` so every consumer
 * (library view, global search, import status) shares one copy of the data
 * and sees refreshes after imports.
 */
export function useLibraryData(): LibraryState {
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      setBooks(next.books);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchLibrary();
        if (cancelled) return;
        setStats(next.stats);
        setBooks(next.books);
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
  }, [fetchCollections]);

  // Imports stream one event per persisted book; patch the list in place so
  // books and covers appear while the scan is still running. The final
  // refresh after the import completes reconciles ordering and stats (the
  // sidebar count lags a few seconds by design).
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onImportProgress((book) => {
      if (disposed) return;
      setBooks((prev) => patchBook(prev, book));
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => console.error("import-progress subscription failed:", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Filesystem synchronization (milestone 3): the watcher pushes book
  // changes (new/updated/relinked/unavailable) and removals live, so the
  // library view tracks the folder without any polling or manual rescan.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onLibraryChanged((change) => {
      if (disposed) return;
      if (change.kind === "changed") {
        setBooks((prev) => patchBook(prev, change.book));
      } else {
        setBooks((prev) => prev.filter((book) => book.id !== change.bookId));
        setStats((prev) =>
          prev === null ? prev : { ...prev, bookCount: Math.max(0, prev.bookCount - 1) },
        );
      }
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
  }, []);

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
