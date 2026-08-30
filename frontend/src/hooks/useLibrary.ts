import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getLibraryStats, listBooks, type Book, type LibraryStats } from "@/lib/tauri";

export interface LibraryState {
  stats: LibraryStats | null;
  books: Book[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
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

/**
 * Fetches the library. Used by `LibraryDataProvider` so every consumer
 * (library view, global search, import status) shares one copy of the data
 * and sees refreshes after imports.
 */
export function useLibraryData(): LibraryState {
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    return () => {
      cancelled = true;
    };
  }, []);

  return { stats, books, loading, error, refresh };
}

export const LibraryDataContext = createContext<LibraryState | null>(null);

export function useLibrary(): LibraryState {
  const library = useContext(LibraryDataContext);
  if (!library) {
    throw new Error("useLibrary must be used within LibraryDataProvider");
  }
  return library;
}
