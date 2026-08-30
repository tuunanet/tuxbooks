import { useCallback, useEffect, useState } from "react";
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

export function useLibrary(): LibraryState {
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
