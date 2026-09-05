import { useCallback, useEffect, useState } from "react";
import {
  clearBookCoverOverride,
  getBookMetadata,
  resetBookMetadata,
  setBookCover,
  updateBookMetadata,
} from "@/lib/tauri";
import type { BookMetadata, MetadataFields } from "@/types/domain";

interface LoadedView {
  bookId: number;
  metadata: BookMetadata | null;
  error: string | null;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loads a book's curation view (effective + source + overridden flags) and
 * exposes the milestone-7 mutations. The loaded view belongs to its book:
 * while another book loads, the visible state is empty instead of stale.
 * Metadata edits emit `library-changed` on the backend, so the library grid
 * refreshes through the shared subscription — this hook only owns the
 * editor's own data.
 */
export function useBookMetadata(bookId: number | null) {
  const [loaded, setLoaded] = useState<LoadedView | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (bookId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const view = await getBookMetadata(bookId);
        if (!cancelled) setLoaded({ bookId, metadata: view, error: null });
      } catch (err) {
        if (!cancelled) setLoaded({ bookId, metadata: null, error: toMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const current = loaded !== null && loaded.bookId === bookId ? loaded : null;
  // A fetch is in flight whenever the loaded view still belongs to another
  // (or no) book — derived, so book switches never show stale data.
  const loading = bookId !== null && current === null;
  const metadata = current === null ? null : current.metadata;
  const error = current === null ? null : current.error;

  const save = useCallback(
    async (form: MetadataFields) => {
      if (bookId === null) return undefined;
      setSaving(true);
      try {
        const saved = await updateBookMetadata(bookId, form);
        setLoaded({ bookId, metadata: saved, error: null });
        return saved;
      } catch (err) {
        setLoaded({ bookId, metadata: null, error: toMessage(err) });
        return undefined;
      } finally {
        setSaving(false);
      }
    },
    [bookId],
  );

  const reset = useCallback(async () => {
    if (bookId === null) return;
    setSaving(true);
    try {
      setLoaded({ bookId, metadata: await resetBookMetadata(bookId), error: null });
    } catch (err) {
      setLoaded({ bookId, metadata: null, error: toMessage(err) });
    } finally {
      setSaving(false);
    }
  }, [bookId]);

  const changeCover = useCallback(
    async (imagePath: string) => {
      if (bookId === null) return;
      try {
        await setBookCover(bookId, imagePath);
        setLoaded({ bookId, metadata: await getBookMetadata(bookId), error: null });
      } catch (err) {
        setLoaded({ bookId, metadata: null, error: toMessage(err) });
      }
    },
    [bookId],
  );

  const restoreCover = useCallback(async () => {
    if (bookId === null) return;
    try {
      await clearBookCoverOverride(bookId);
      setLoaded({ bookId, metadata: await getBookMetadata(bookId), error: null });
    } catch (err) {
      setLoaded({ bookId, metadata: null, error: toMessage(err) });
    }
  }, [bookId]);

  return { metadata, loading, saving, error, save, reset, changeCover, restoreCover };
}
