import { useCallback } from "react";
import {
  addBookToCollection,
  createCollection,
  deleteCollection,
  removeBookFromCollection,
  type CollectionSummary,
} from "@/lib/bridge";
import { useLibrary } from "./useLibrary";

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * User-driven collection management (milestone 10): create and delete
 * collections, and move books in and out of them. Every mutation refreshes
 * the shared collection copy in `useLibraryData`, so the sidebar, the
 * collection sections, and the context menus stay in sync.
 */
export function useCollectionActions() {
  const { refreshCollections } = useLibrary();

  const create = useCallback(
    async (
      name: string,
    ): Promise<{ ok: boolean; error?: string; collection?: CollectionSummary }> => {
      try {
        const collection = await createCollection(name);
        await refreshCollections();
        return { ok: true, collection };
      } catch (err) {
        return { ok: false, error: toMessage(err) };
      }
    },
    [refreshCollections],
  );

  const remove = useCallback(
    async (collectionId: number) => {
      try {
        await deleteCollection(collectionId);
        await refreshCollections();
      } catch (err) {
        console.error("delete collection failed:", toMessage(err));
      }
    },
    [refreshCollections],
  );

  const addBook = useCallback(
    async (bookId: number, collectionId: number) => {
      try {
        await addBookToCollection(bookId, collectionId);
        await refreshCollections();
      } catch (err) {
        console.error("add to collection failed:", toMessage(err));
      }
    },
    [refreshCollections],
  );

  const removeBook = useCallback(
    async (bookId: number, collectionId: number) => {
      try {
        await removeBookFromCollection(bookId, collectionId);
        await refreshCollections();
      } catch (err) {
        console.error("remove from collection failed:", toMessage(err));
      }
    },
    [refreshCollections],
  );

  // Bulk membership: one call per book, then a single shared refresh. A
  // rejected call is logged and left behind so the rest of the batch still
  // lands, and the count of what actually changed comes back for the note.
  const addMany = useCallback(
    async (bookIds: number[], collectionId: number): Promise<number> => {
      let applied = 0;
      for (const bookId of bookIds) {
        try {
          await addBookToCollection(bookId, collectionId);
          applied += 1;
        } catch (err) {
          console.error("add to collection failed:", toMessage(err));
        }
      }
      await refreshCollections();
      return applied;
    },
    [refreshCollections],
  );

  const removeMany = useCallback(
    async (bookIds: number[], collectionId: number): Promise<number> => {
      let applied = 0;
      for (const bookId of bookIds) {
        try {
          await removeBookFromCollection(bookId, collectionId);
          applied += 1;
        } catch (err) {
          console.error("remove from collection failed:", toMessage(err));
        }
      }
      await refreshCollections();
      return applied;
    },
    [refreshCollections],
  );

  return { create, remove, addBook, removeBook, addMany, removeMany };
}
