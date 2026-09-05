import { useCallback } from "react";
import {
  addBookToCollection,
  createCollection,
  deleteCollection,
  removeBookFromCollection,
  type CollectionSummary,
} from "@/lib/tauri";
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

  return { create, remove, addBook, removeBook };
}
