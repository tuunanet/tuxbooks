import { useEffect, useRef, useState } from "react";
import { getReadingProgress, saveReadingProgress } from "@/lib/tauri";

/** How long position changes are coalesced before hitting SQLite. */
export const PROGRESS_SAVE_DEBOUNCE_MS = 1000;

/** A valid stored EPUB locator: canonical CFI plus its spine href. */
export interface EpubLocator {
  cfi: string;
  chapterHref: string | null;
}

interface EpubPersistenceOptions {
  bookId: number;
  /** True once the engine view is ready; restoration waits for this. */
  enabled: boolean;
  /** Latest locator reported by the engine's relocate event. */
  locator: EpubLocator | null;
  /** Coarse shell position (0–100) stored alongside the CFI. */
  position: number;
  /** Called once restoration settled: the saved CFI, or null to start fresh. */
  onRestored: (savedCfi: string | null) => void;
}

/**
 * Reading-position persistence for the EPUB reader, following the PDF
 * reader's contract. Restore: after the engine view is ready, the saved
 * locator is fetched exactly once; a missing or malformed CFI degrades to
 * opening at the start of the book. Save: locator changes are debounced so
 * continuous scrolling never writes per event, and a final flush runs on
 * unmount (reader closed). Errors are logged, never surfaced — losing a
 * position write must not break reading.
 */
export function useEpubPersistence({
  bookId,
  enabled,
  locator,
  position,
  onRestored,
}: EpubPersistenceOptions): { restored: boolean } {
  const [restored, setRestored] = useState(false);
  const onRestoredRef = useRef(onRestored);
  useEffect(() => {
    onRestoredRef.current = onRestored;
  });

  const latestRef = useRef({ locator, position });
  useEffect(() => {
    latestRef.current = { locator, position };
  });

  // Restore exactly once, after the engine view is ready.
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
        restoredRef.current = true;
        setRestored(true);
        const cfi = saved?.cfi;
        if (typeof cfi === "string" && cfi.startsWith("epubcfi(")) {
          onRestoredRef.current?.(cfi);
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
  }, [enabled, bookId]);

  // Debounced save of position changes, armed only after restoration. The
  // first armed run sees the restored location itself and is skipped, so
  // merely opening a book never writes to the database.
  const skipFirstSaveRef = useRef(true);
  useEffect(() => {
    if (!enabled || !restored) return;
    if (skipFirstSaveRef.current) {
      skipFirstSaveRef.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      const { locator: latest } = latestRef.current;
      if (!latest) return;
      void saveReadingProgress(bookId, {
        cfi: latest.cfi,
        chapterHref: latest.chapterHref,
        progressPercent: latestRef.current.position,
      }).catch((err: unknown) => {
        console.error("Failed to save reading position", err);
      });
    }, PROGRESS_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, restored, bookId, locator, position]);

  // Final flush when the reader closes; best-effort, never blocking.
  const bookIdRef = useRef(bookId);
  useEffect(() => {
    bookIdRef.current = bookId;
  });
  useEffect(
    () => () => {
      if (restoredRef.current) {
        const { locator: latest, position: latestPosition } = latestRef.current;
        if (latest) {
          void saveReadingProgress(bookIdRef.current, {
            cfi: latest.cfi,
            chapterHref: latest.chapterHref,
            progressPercent: latestPosition,
          }).catch(() => {});
        }
      }
    },
    [],
  );

  return { restored };
}
