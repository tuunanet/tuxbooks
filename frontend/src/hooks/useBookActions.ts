import { useCallback } from "react";
import {
  forgetBook,
  markBookFinished,
  pickBookFile,
  reconnectBook,
  removeBook,
  removeBookFile as removeBookFileCommand,
  resetBookReadingData,
  retryIndexing as retryBookIndexing,
} from "@/lib/bridge";
import { useLibrary } from "./useLibrary";

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const INDEXING_RETRY_FAILED =
  "TuxBooks still could not index this book. It will keep trying while the file can be read.";
const INDEXING_FILE_MISSING = "The file is not available. Use Locate File, then retry indexing.";

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

  /**
   * Drop one file copy. The durable book and its reading state stay while
   * another location remains; the file on disk is never touched.
   */
  const removeBookFile = useCallback(async (bookId: number, fileId: number) => {
    try {
      await removeBookFileCommand(bookId, fileId);
      return true;
    } catch (err) {
      console.error("remove copy failed:", toMessage(err));
      return false;
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

  /**
   * Retry the content-hash pass for one book. The backend runs the hash now
   * instead of waiting for its backoff; the library refresh then decides
   * whether the warning stays. A still-failed result keeps the warning and
   * returns the message the detail view shows.
   */
  const retryIndexing = useCallback(
    async (bookId: number): Promise<{ ok: boolean; error: string | null }> => {
      try {
        const result = await retryBookIndexing(bookId);
        await refresh();
        if (result.hashState === "hashed") return { ok: true, error: null };
        return {
          ok: false,
          error: result.hashState === "missing" ? INDEXING_FILE_MISSING : INDEXING_RETRY_FAILED,
        };
      } catch (err) {
        console.error("retry indexing failed:", toMessage(err));
        await refresh();
        return { ok: false, error: INDEXING_RETRY_FAILED };
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
    removeBookFile,
    resetReadingData,
    forgetBookFromLibrary,
    retryIndexing,
    markFinished,
    markManyFinished,
  };
}
