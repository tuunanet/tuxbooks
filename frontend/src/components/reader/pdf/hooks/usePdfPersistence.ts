import { useEffect, useRef, useState } from "react";
import { getReadingProgress, saveReadingProgress } from "@/lib/tauri";

/** How long position changes are coalesced before hitting SQLite. */
export const PROGRESS_SAVE_DEBOUNCE_MS = 1000;

interface PdfPersistenceOptions {
  bookId: number;
  /** True once the document layout is ready; restoration waits for this. */
  enabled: boolean;
  currentPage: number;
  position: number;
  pageCount: number;
  /** Called once restoration settled: the saved page, or null to start at 1. */
  onRestored: (savedPage: number | null) => void;
}

/**
 * Reading-position persistence for the PDF reader.
 *
 * Restore: after the layout is ready, the saved page is fetched exactly once
 * and handed to `onRestored`; invalid (out-of-range/corrupt) values are
 * treated as absent, and fetch failures degrade to starting at page 1.
 *
 * Save: page changes are debounced so scrolling never writes per event, and
 * a final flush runs on unmount (reader closed). Errors are logged, never
 * surfaced — losing a position write must not break reading.
 */
export function usePdfPersistence({
  bookId,
  enabled,
  currentPage,
  position,
  pageCount,
  onRestored,
}: PdfPersistenceOptions): { restored: boolean } {
  const [restored, setRestored] = useState(false);
  const onRestoredRef = useRef(onRestored);
  useEffect(() => {
    onRestoredRef.current = onRestored;
  });

  const latestRef = useRef({ currentPage, position });
  useEffect(() => {
    latestRef.current = { currentPage, position };
  });

  // Restore exactly once, after the layout is ready.
  const restoreStartedRef = useRef(false);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!enabled || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const saved = await getReadingProgress(bookId);
        if (cancelled) return;
        const page = saved?.pageNumber;
        restoredRef.current = true;
        setRestored(true);
        if (typeof page === "number" && Number.isInteger(page) && page >= 1 && page <= pageCount) {
          onRestoredRef.current?.(page);
        } else {
          onRestoredRef.current?.(null);
        }
      } catch (err: unknown) {
        console.error("Failed to load reading position", err);
        if (!cancelled) {
          restoredRef.current = true;
          setRestored(true);
          onRestoredRef.current?.(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, bookId, pageCount]);

  // Debounced save of position changes, armed only after restoration. The
  // first armed run sees the restored values themselves and is skipped, so
  // merely opening a book never writes to the database.
  const skipFirstSaveRef = useRef(true);
  useEffect(() => {
    if (!enabled || !restored) return;
    if (skipFirstSaveRef.current) {
      skipFirstSaveRef.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      void saveReadingProgress(bookId, {
        pageNumber: latestRef.current.currentPage,
        progressPercent: latestRef.current.position,
      }).catch((err: unknown) => {
        console.error("Failed to save reading position", err);
      });
    }, PROGRESS_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, restored, bookId, currentPage, position]);

  // Final flush when the reader closes; best-effort, never blocking.
  const bookIdRef = useRef(bookId);
  useEffect(() => {
    bookIdRef.current = bookId;
  });
  useEffect(
    () => () => {
      if (restoredRef.current) {
        void saveReadingProgress(bookIdRef.current, {
          pageNumber: latestRef.current.currentPage,
          progressPercent: latestRef.current.position,
        }).catch(() => {});
      }
    },
    [],
  );

  return { restored };
}
