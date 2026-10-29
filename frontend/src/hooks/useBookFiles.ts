import { useCallback, useEffect, useState } from "react";
import { listBookFiles, type BookFile } from "@/lib/bridge";

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The file locations of one durable book (ADR 0014 D7). The library entry is
 * one book; the details list every copy and can remove one without dropping
 * the book or its reading state.
 */
export function useBookFiles(bookId: number | null) {
  // The loaded book id travels with its files, so a switch renders the new
  // book's empty list instead of the previous book's locations.
  const [loaded, setLoaded] = useState<{ bookId: number; files: BookFile[] } | null>(null);

  useEffect(() => {
    if (bookId === null) return;
    let cancelled = false;
    void listBookFiles(bookId)
      .then((files) => {
        if (!cancelled) setLoaded({ bookId, files });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoaded({ bookId, files: [] });
        console.error("list book files failed:", toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  /** Re-read after removing a copy; the same book id keeps its state. */
  const refresh = useCallback(async () => {
    if (bookId === null) return;
    try {
      setLoaded({ bookId, files: await listBookFiles(bookId) });
    } catch (err) {
      console.error("list book files failed:", toMessage(err));
    }
  }, [bookId]);

  return {
    files: loaded !== null && loaded.bookId === bookId ? loaded.files : [],
    refresh,
  };
}
