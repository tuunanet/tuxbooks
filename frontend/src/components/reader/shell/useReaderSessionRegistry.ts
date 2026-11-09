import { useEffect } from "react";
import { readerClosed, readerOpened } from "@/lib/bridge";

/**
 * Open-book deferral (ADR 0018 D5): register this book's reader session with
 * the sync engine when the reader opens it and release the registration on
 * close or book switch, so adoption only swaps bytes while nothing is
 * reading them. Best effort, mirroring `useMarkBookOpened`: a failed call
 * never blocks reading, and a missed close self-heals when the app exits
 * (the registry is in-memory sidecar state that dies with the process).
 */
export function useReaderSessionRegistry(bookId: number) {
  useEffect(() => {
    if (bookId === -1) return;
    void readerOpened(bookId).catch(() => {});
    return () => {
      void readerClosed(bookId).catch(() => {});
    };
  }, [bookId]);
}
