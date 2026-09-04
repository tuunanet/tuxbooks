import { useEffect, useState } from "react";
import { EpubViewHandle } from "@/lib/epub/epubEngine";
import { getBookBytes } from "@/lib/tauri";

export type EpubDocumentStatus = "loading" | "ready" | "error";

export interface EpubDocumentState {
  status: EpubDocumentStatus;
  handle: EpubViewHandle | null;
  error: string | null;
}

interface EpubDocumentSnapshot extends EpubDocumentState {
  bookId: number;
}

/**
 * Loads a book's bytes through `get_book_bytes` and opens them in a
 * `<foliate-view>` engine handle. The hook owns the engine lifetime:
 * switching books or unmounting closes the view, and an open that finishes
 * after its effect was superseded never touches React state.
 *
 * The hook takes no callbacks — consumers subscribe to the returned handle's
 * events (`onRelocate`, `onLoad`, …) in their own effects, which keeps refs
 * out of hook arguments.
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
    let opened: EpubViewHandle | null = null;

    (async () => {
      try {
        const bytes = await getBookBytes(bookId);
        const { host, handle: view } = EpubViewHandle.create();
        host.dataset.epubState = "opening";
        await view.open(bytes);
        if (cancelled) {
          view.close();
          return;
        }
        opened = view;
        setSnapshot((current) => ({ ...current, handle: view, status: "ready" }));
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
      opened?.close();
    };
  }, [bookId]);

  return { status: snapshot.status, handle: snapshot.handle, error: snapshot.error };
}
