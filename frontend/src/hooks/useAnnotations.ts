import { useCallback, useEffect, useRef, useState } from "react";
import { createAnnotation, deleteAnnotation, listAnnotations, updateAnnotation } from "@/lib/tauri";
import type { Annotation, AnnotationInput, AnnotationPatch } from "@/types/domain";

interface AnnotationSnapshot {
  bookId: number;
  annotations: Annotation[];
}

/**
 * Persistent annotations (bookmarks, highlights, notes) for the book open
 * in the reader. Loads once per book — readers remount per book, but the
 * shell does not — and keeps the list in sync as create/update/delete
 * calls land. The list belongs to its snapshot's book: while another book
 * is loading, the visible list is empty instead of stale.
 */
export function useAnnotations(bookId: number | null) {
  const [snapshot, setSnapshot] = useState<AnnotationSnapshot>({ bookId: -1, annotations: [] });
  const current = snapshot.bookId === bookId ? snapshot.annotations : [];
  const bookIdRef = useRef(bookId);
  useEffect(() => {
    bookIdRef.current = bookId;
  });

  useEffect(() => {
    if (bookId === null) return;
    let cancelled = false;
    (async () => {
      try {
        const annotations = await listAnnotations(bookId);
        if (!cancelled) setSnapshot({ bookId, annotations });
      } catch (err: unknown) {
        console.error("Failed to load annotations", err);
        if (!cancelled) setSnapshot({ bookId, annotations: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const create = useCallback(async (input: AnnotationInput): Promise<Annotation | null> => {
    const target = bookIdRef.current;
    if (target === null || target < 0) return null;
    try {
      const stored = await createAnnotation(target, input);
      setSnapshot(({ bookId, annotations }) =>
        bookId === stored.bookId
          ? { bookId, annotations: [...annotations, stored] }
          : { bookId, annotations },
      );
      return stored;
    } catch (err: unknown) {
      console.error("Failed to create annotation", err);
      return null;
    }
  }, []);

  const update = useCallback(async (id: number, patch: AnnotationPatch): Promise<void> => {
    try {
      const updated = await updateAnnotation(id, patch);
      if (!updated) return;
      setSnapshot(({ bookId, annotations }) => ({
        bookId,
        annotations: annotations.map((annotation) => (annotation.id === id ? updated : annotation)),
      }));
    } catch (err: unknown) {
      console.error("Failed to update annotation", err);
    }
  }, []);

  const remove = useCallback(async (id: number): Promise<void> => {
    try {
      const removed = await deleteAnnotation(id);
      if (!removed) return;
      setSnapshot(({ bookId, annotations }) => ({
        bookId,
        annotations: annotations.filter((annotation) => annotation.id !== id),
      }));
    } catch (err: unknown) {
      console.error("Failed to delete annotation", err);
    }
  }, []);

  return { annotations: current, create, update, remove };
}
