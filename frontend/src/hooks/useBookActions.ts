import { useCallback } from "react";
import { markBookFinished, pickBookFile, reconnectBook, removeBook } from "@/lib/bridge";
import { useLibrary } from "./useLibrary";

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * User-driven library maintenance (ROADMAP milestone 3): reconnect a book
 * whose file disappeared to a newly located file, or remove it from the
 * library entirely. Both commands emit `library-changed`, so the UI updates
 * through the shared subscription in `useLibraryData` — no local state
 * juggling, and no fake success when the backend rejects the action.
 *
 * `markFinished` (milestone 10) flags a book as read via the progress table;
 * it re-fetches the shared book list so the "Finished" section updates.
 */
export function useBookActions() {
  const { refresh } = useLibrary();

  const locateBook = useCallback(async (bookId: number) => {
    const path = await pickBookFile();
    if (path === null || path.trim() === "") return;
    try {
      await reconnectBook(bookId, path);
    } catch (err) {
      console.error("reconnect failed:", toMessage(err));
    }
  }, []);

  const removeBookFromLibrary = useCallback(async (bookId: number) => {
    try {
      await removeBook(bookId);
    } catch (err) {
      console.error("remove failed:", toMessage(err));
    }
  }, []);

  const markFinished = useCallback(
    async (bookId: number) => {
      try {
        await markBookFinished(bookId);
        await refresh();
      } catch (err) {
        console.error("mark finished failed:", toMessage(err));
      }
    },
    [refresh],
  );

  /**
   * Flags every given book as finished; one refresh for the whole batch.
   * A rejected call is logged and left behind, and the count of what
   * actually changed comes back for the note.
   */
  const markManyFinished = useCallback(
    async (bookIds: number[]): Promise<number> => {
      let applied = 0;
      for (const bookId of bookIds) {
        try {
          await markBookFinished(bookId);
          applied += 1;
        } catch (err) {
          console.error("mark finished failed:", toMessage(err));
        }
      }
      await refresh();
      return applied;
    },
    [refresh],
  );

  return { locateBook, removeBookFromLibrary, markFinished, markManyFinished };
}
