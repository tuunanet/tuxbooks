import { useEffect } from "react";
import { markBookOpened } from "@/lib/bridge";

/**
 * Reading session lifecycle: stamp `last_opened_at` once per open so the
 * "Recently read" section and the detail view's "Last opened" reflect this
 * session even if the reader closes without a position save. Best-effort: a
 * failed stamp must not block reading.
 */
export function useMarkBookOpened(bookId: number) {
  useEffect(() => {
    if (bookId === -1) return;
    void markBookOpened(bookId).catch(() => {});
  }, [bookId]);
}
