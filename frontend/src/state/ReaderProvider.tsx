import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_READER_PREFERENCES,
  ReaderContext,
  type ReaderBookmark,
  type ReaderPreferences,
} from "./readerState";

/**
 * Owns reader-session state: appearance preferences, reading position, and
 * session-scoped bookmarks. Everything resets when the reader unmounts —
 * persistence arrives with the backend reading-progress commands.
 */
export function ReaderProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferencesState] = useState<ReaderPreferences>(
    DEFAULT_READER_PREFERENCES,
  );
  const [position, setPositionState] = useState(0);
  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);

  const setPosition = useCallback((percentage: number) => {
    setPositionState(Math.max(0, Math.min(100, percentage)));
  }, []);

  const setPreferences = useCallback((patch: Partial<ReaderPreferences>) => {
    setPreferencesState((current) => ({ ...current, ...patch }));
  }, []);

  const toggleBookmark = useCallback(() => {
    setPositionState((currentPosition) => {
      const rounded = Math.round(currentPosition);
      setBookmarks((current) => {
        const existing = current.find((bookmark) => Math.round(bookmark.percentage) === rounded);
        if (existing) {
          return current.filter((bookmark) => bookmark.id !== existing.id);
        }
        const bookmark: ReaderBookmark = {
          id: `bookmark-${rounded}-${current.length}`,
          percentage: rounded,
          label: `Position ${rounded}%`,
        };
        return [...current, bookmark].sort((a, b) => a.percentage - b.percentage);
      });
      return currentPosition;
    });
  }, []);

  const value = useMemo(
    () => ({ preferences, position, bookmarks, setPosition, setPreferences, toggleBookmark }),
    [preferences, position, bookmarks, setPosition, setPreferences, toggleBookmark],
  );

  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>;
}
