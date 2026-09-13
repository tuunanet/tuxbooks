import { useCallback, useEffect, useState } from "react";
import {
  clearBookCoverOverride,
  embedBookMetadata,
  getBookMetadata,
  resetBookMetadata,
  setBookCover,
  setMetadataFieldSource,
  updateBookMetadata,
} from "@/lib/bridge";
import type {
  BookMetadata,
  MetadataFieldSource,
  MetadataFieldSources,
  MetadataFields,
} from "@/types/domain";

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
  const [embedding, setEmbedding] = useState(false);
  // Scoped to the book it happened on, like `loaded`, so switching books
  // never shows another book's embed outcome.
  const [embedFailure, setEmbedFailure] = useState<{ bookId: number; error: string } | null>(null);
  const [embedDone, setEmbedDone] = useState<{ bookId: number } | null>(null);

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
      setEmbedDone(null);
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
    setEmbedDone(null);
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

  /**
   * Choose which layer is authoritative for one field (`null` restores the
   * default). The override is kept either way, so switching back is lossless.
   */
  const setFieldSource = useCallback(
    async (field: keyof MetadataFieldSources, source: MetadataFieldSource | null) => {
      if (bookId === null) return;
      setSaving(true);
      setEmbedDone(null);
      try {
        const view = await setMetadataFieldSource(bookId, field, source);
        setLoaded({ bookId, metadata: view, error: null });
      } catch (err) {
        setLoaded({ bookId, metadata: null, error: toMessage(err) });
      } finally {
        setSaving(false);
      }
    },
    [bookId],
  );

  /**
   * Explicit "Embed into file": the backend persists the form and writes it
   * into the source EPUB/PDF, then re-parses the file. Passing the form means
   * unsaved edits are embedded too — Save is not required first. Failures
   * keep the form and show an inline message.
   */
  const embed = useCallback(
    async (form: MetadataFields) => {
      if (bookId === null) return;
      setEmbedding(true);
      setEmbedFailure(null);
      setEmbedDone(null);
      try {
        const view = await embedBookMetadata(bookId, form);
        setLoaded({ bookId, metadata: view, error: null });
        setEmbedDone({ bookId });
      } catch (err) {
        setEmbedFailure({ bookId, error: toMessage(err) });
      } finally {
        setEmbedding(false);
      }
    },
    [bookId],
  );

  const embedError =
    embedFailure !== null && embedFailure.bookId === bookId ? embedFailure.error : null;
  const embedSuccess = embedDone !== null && embedDone.bookId === bookId;

  return {
    metadata,
    loading,
    saving,
    embedding,
    error,
    embedError,
    embedSuccess,
    save,
    reset,
    changeCover,
    restoreCover,
    setFieldSource,
    embed,
  };
}

/** The curation view and mutations a loaded book exposes to its editors. */
export type BookMetadataCuration = ReturnType<typeof useBookMetadata>;
