import { useCallback, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_READER_PREFERENCES, ReaderContext, type ReaderPreferences } from "./readerState";

/**
 * Owns reader-session state: appearance preferences and reading position.
 * Everything resets when the reader unmounts; position is persisted through
 * the backend progress commands and annotations (bookmarks, highlights,
 * notes) through the annotations commands.
 */
export function ReaderProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferencesState] = useState<ReaderPreferences>(
    DEFAULT_READER_PREFERENCES,
  );
  const [position, setPositionState] = useState(0);

  const setPosition = useCallback((percentage: number) => {
    setPositionState(Math.max(0, Math.min(100, percentage)));
  }, []);

  const setPreferences = useCallback((patch: Partial<ReaderPreferences>) => {
    setPreferencesState((current) => ({ ...current, ...patch }));
  }, []);

  const value = useMemo(
    () => ({ preferences, position, setPosition, setPreferences }),
    [preferences, position, setPosition, setPreferences],
  );

  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>;
}
