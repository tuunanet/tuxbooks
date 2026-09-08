import { useEffect, useState } from "react";
import { ReadiumEpubHandle } from "@/lib/epub/readiumEngine";

export type EpubDocumentStatus = "loading" | "ready" | "error";

export interface EpubDocumentState {
  status: EpubDocumentStatus;
  handle: ReadiumEpubHandle | null;
  error: string | null;
}

interface EpubDocumentSnapshot extends EpubDocumentState {
  bookId: number;
}

/**
 * Opens a book through the Readium seam (`ReadiumEpubHandle.open`: session
 * fetch → publication build). The hook owns the handle lifetime: switching
 * books or unmounting closes it, and an open that finishes after its effect
 * was superseded never touches React state.
 *
 * The hook takes no callbacks — consumers subscribe to the returned
 * handle's events (`onRelocate`, `onLoad`, …) in their own effects, which
 * keeps refs out of hook arguments.
 */
export function useEpubDocument(bookId: number): EpubDocumentState {
  const [snapshot, setSnapshot] = useState<EpubDocumentSnapshot>(() => ({
    bookId,
    status: "loading",
    handle: null,
    error: null,
  }));
  // Render-phase reset on book switch (mirrors usePdfDocument): the closed
  // engine's handle and host leave state immediately instead of lingering
  // until the next book finishes opening.
  if (snapshot.bookId !== bookId) {
    setSnapshot({ bookId, status: "loading", handle: null, error: null });
  }

  useEffect(() => {
    let cancelled = false;
    let opened: ReadiumEpubHandle | null = null;

    (async () => {
      try {
        const handle = await ReadiumEpubHandle.open(bookId);
        handle.hostElement.dataset.epubState = "opening";
        if (cancelled) {
          await handle.close();
          return;
        }
        opened = handle;
        setSnapshot((current) => ({ ...current, handle, status: "ready" }));
      } catch (err: unknown) {
        if (!cancelled) {
          setSnapshot((current) => ({
            ...current,
            error: err instanceof Error ? err.message : String(err),
            status: "error",
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
      void opened?.close();
    };
  }, [bookId]);

  return { status: snapshot.status, handle: snapshot.handle, error: snapshot.error };
}
