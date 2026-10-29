import { useCallback } from "react";
import {
  forgetBook,
  markBookFinished,
  pickBookFile,
  reconnectBook,
  removeBook,
  resetBookReadingData,
} from "@/lib/bridge";
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

  /** Reset keeps the book and file; only user-owned reading state goes. */
  const resetReadingData = useCallback(
    async (bookId: number) => {
      try {
        await resetBookReadingData(bookId);
        await refresh();
      } catch (err) {
        console.error("reset reading data failed:", toMessage(err));
      }
    },
    [refresh],
  );

  /**
   * Forget moves the old identity to the 30-day trash. A book with a file
   * stays in the library under a fresh identity.
   */
  const forgetBookFromLibrary = useCallback(
    async (bookId: number) => {
      try {
        await forgetBook(bookId);
        await refresh();
      } catch (err) {
        console.error("forget failed:", toMessage(err));
      }
    },
    [refresh],
  );

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

  return {
    locateBook,
    removeBookFromLibrary,
    resetReadingData,
    forgetBookFromLibrary,
    markFinished,
    markManyFinished,
  };
}
