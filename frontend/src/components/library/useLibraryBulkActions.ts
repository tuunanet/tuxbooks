import { useCallback, useEffect, useState } from "react";
import type { useBookActions } from "@/hooks/useBookActions";
import type { useCollectionActions } from "@/hooks/useCollectionActions";
import { useAppDispatch } from "@/state/appState";
import type { Book, CollectionSummary } from "@/types/domain";

/** How long the result note stays on the selection bar. */
const BULK_MESSAGE_MS = 4000;

interface UseLibraryBulkActionsInput {
  selectedIds: number[];
  books: Book[];
  bookActions: ReturnType<typeof useBookActions>;
  collectionActions: ReturnType<typeof useCollectionActions>;
  refresh: () => Promise<void>;
}

/**
 * Bulk actions from the selection bar: remove, collection membership, and
 * mark finished, plus the transient note that reports what changed.
 */
export function useLibraryBulkActions({
  selectedIds,
  books,
  bookActions,
  collectionActions,
  refresh,
}: UseLibraryBulkActionsInput) {
  const dispatch = useAppDispatch();
  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const { removeBookFromLibrary, markManyFinished } = bookActions;

  // The per-book call only drops the library entry, never the file on disk;
  // one refresh at the end picks up every removal.
  const confirmBulkRemove = useCallback(async () => {
    const ids = selectedIds;
    setBulkRemoveOpen(false);
    for (const id of ids) await removeBookFromLibrary(id);
    await refresh();
    dispatch({ type: "clear-library-selection" });
    setBulkMessage(`Removed ${ids.length} books from the library`);
  }, [selectedIds, removeBookFromLibrary, refresh, dispatch]);

  // Membership ops work on the selected ids only: the menu lists a collection
  // only when the selection differs from it, so the batch is never empty and
  // the note counts what the bridge calls changed. The selection is never
  // cleared, so the next action chains off the same set.
  const bulkAddToCollection = useCallback(
    async (collection: CollectionSummary) => {
      const ids = selectedIds.filter((id) => !collection.bookIds.includes(id));
      const applied = await collectionActions.addMany(ids, collection.id);
      setBulkMessage(`Added ${applied} to ${collection.name}`);
    },
    [selectedIds, collectionActions],
  );

  const bulkRemoveFromCollection = useCallback(
    async (collection: CollectionSummary) => {
      const ids = selectedIds.filter((id) => collection.bookIds.includes(id));
      const applied = await collectionActions.removeMany(ids, collection.id);
      setBulkMessage(`Removed ${applied} from ${collection.name}`);
    },
    [selectedIds, collectionActions],
  );

  // Unfinished selections only: already-finished books are skipped silently,
  // and the selection survives so the next action can chain off it.
  const bulkMarkFinished = useCallback(async () => {
    const targets = selectedIds.filter((id) => {
      const book = books.find((candidate) => candidate.id === id);
      if (!book) return false;
      return !(book.progressPercent !== null && book.progressPercent >= 100);
    });
    if (targets.length === 0) {
      setBulkMessage("All selected books are already finished");
      return;
    }
    const applied = await markManyFinished(targets);
    setBulkMessage(`Marked ${applied} books as finished`);
  }, [selectedIds, books, markManyFinished]);

  useEffect(() => {
    if (bulkMessage === null) return;
    const timer = window.setTimeout(() => setBulkMessage(null), BULK_MESSAGE_MS);
    return () => window.clearTimeout(timer);
  }, [bulkMessage]);

  return {
    bulkRemoveOpen,
    setBulkRemoveOpen,
    bulkMessage,
    confirmBulkRemove,
    bulkAddToCollection,
    bulkRemoveFromCollection,
    bulkMarkFinished,
  };
}
