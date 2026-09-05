import { useEffect, useRef, useState } from "react";
import { getReadingProgress, saveReadingProgress } from "@/lib/tauri";
import type { ReadingProgressInput, ReadingProgressRecord } from "@/types/domain";

/** How long position changes are coalesced before hitting SQLite. */
export const PROGRESS_SAVE_DEBOUNCE_MS = 1000;

interface ReaderProgressOptions<Saved> {
  bookId: number;
  /** True once the format reader is ready to apply a restored position. */
  enabled: boolean;
  /** Latest position to persist (format-specific payload); null saves nothing. */
  current: Saved | null;
  /** Coarse shell position (0–100) stored alongside the locator. */
  position: number;
  /** Validates a stored row into a restored payload, or null to start fresh. */
  parseRestored: (record: ReadingProgressRecord | null) => Saved | null;
  /** Called once restoration settled; failure degrades to `null`. */
  onRestored: (restored: Saved | null) => void;
  /** Builds the wire payload for a save. */
  savePayload: (current: Saved, position: number) => ReadingProgressInput;
}

/**
 * Reading-position persistence shared by both format readers (the unified
 * reader model's persistence contract). Restore: after `enabled`, the saved
 * row is fetched exactly once and handed to `onRestored` through
 * `parseRestored`; fetch failures degrade to starting fresh. Save: position
 * changes are debounced so continuous scrolling never writes per event, the
 * first armed run is skipped so merely opening a book writes nothing, and a
 * final flush runs on unmount (reader closed). Errors are logged, never
 * surfaced — losing a position write must not break reading.
 */
export function useReaderProgress<Saved>({
  bookId,
  enabled,
  current,
  position,
  parseRestored,
  onRestored,
  savePayload,
}: ReaderProgressOptions<Saved>): { restored: boolean } {
  const [restored, setRestored] = useState(false);
  const onRestoredRef = useRef(onRestored);
  useEffect(() => {
    onRestoredRef.current = onRestored;
  });
  const parseRestoredRef = useRef(parseRestored);
  useEffect(() => {
    parseRestoredRef.current = parseRestored;
  });
  const savePayloadRef = useRef(savePayload);
  useEffect(() => {
    savePayloadRef.current = savePayload;
  });

  const latestRef = useRef({ current, position });
  useEffect(() => {
    latestRef.current = { current, position };
  });

  // Restore exactly once, after the reader is ready.
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
        onRestoredRef.current?.(parseRestoredRef.current(saved));
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
      const latest = latestRef.current;
      if (latest.current === null) return;
      void saveReadingProgress(
        bookId,
        savePayloadRef.current(latest.current, latest.position),
      ).catch((err: unknown) => {
        console.error("Failed to save reading position", err);
      });
    }, PROGRESS_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, restored, bookId, current, position]);

  // Final flush when the reader closes; best-effort, never blocking.
  const bookIdRef = useRef(bookId);
  useEffect(() => {
    bookIdRef.current = bookId;
  });
  useEffect(
    () => () => {
      if (restoredRef.current) {
        const latest = latestRef.current;
        if (latest.current !== null) {
          void saveReadingProgress(
            bookIdRef.current,
            savePayloadRef.current(latest.current, latest.position),
          ).catch(() => {});
        }
      }
    },
    [],
  );

  return { restored };
}
