import { useEffect, useState } from "react";
import { EpubViewHandle } from "@/lib/epub/epubEngine";
import { getBookBytes } from "@/lib/tauri";

export type EpubDocumentStatus = "loading" | "ready" | "error";

export interface EpubDocumentState {
  status: EpubDocumentStatus;
  handle: EpubViewHandle | null;
  error: string | null;
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
  const [status, setStatus] = useState<EpubDocumentStatus>("loading");
  const [handle, setHandle] = useState<EpubViewHandle | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        setHandle(view);
        setStatus("ready");
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [bookId]);

  return { status, handle, error };
}
