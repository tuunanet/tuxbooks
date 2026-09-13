import { useEffect, useState } from "react";
import { getBookFileProperties } from "@/lib/bridge";
import type { FileProperties } from "@/types/domain";

interface LoadedFileProperties {
  bookId: number;
  properties: FileProperties | null;
  error: string | null;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loads the read-only native metadata of a book's source file. State is
 * scoped to its book, so switching books never shows stale properties.
 */
export function useBookFileProperties(bookId: number | null) {
  const [loaded, setLoaded] = useState<LoadedFileProperties | null>(null);

  useEffect(() => {
    if (bookId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const properties = await getBookFileProperties(bookId);
        if (!cancelled) setLoaded({ bookId, properties, error: null });
      } catch (err) {
        if (!cancelled) setLoaded({ bookId, properties: null, error: toMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const current = loaded !== null && loaded.bookId === bookId ? loaded : null;
  return {
    properties: current === null ? null : current.properties,
    loading: bookId !== null && current === null,
    error: current === null ? null : current.error,
  };
}
