import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  autoReaderTheme,
  DEFAULT_READER_PREFERENCES,
  ReaderContext,
  type ReaderPreferences,
} from "./readerState";
import type { ResolvedTheme } from "@/lib/theme";

interface ReaderProviderProps {
  children: ReactNode;
  /**
   * Global resolved theme the reader surface follows while no theme has
   * been picked in the appearance menu — including live OS flips. An
   * explicit pick (including "Default") pins the surface for the reader
   * session. Defaults to "light" (publisher colors) when mounted without a
   * global ThemeStateProvider above — unit tests and previews.
   */
  globalTheme?: ResolvedTheme;
}

/**
 * Owns reader-session state: appearance preferences and reading position.
 * Everything resets when the reader unmounts; position is persisted through
 * the backend progress commands and annotations (bookmarks, highlights,
 * notes) through the annotations commands.
 */
export function ReaderProvider({ children, globalTheme = "light" }: ReaderProviderProps) {
  const [preferences, setPreferencesState] = useState<ReaderPreferences>(
    DEFAULT_READER_PREFERENCES,
  );
  const [themePinned, setThemePinned] = useState(false);
  const [position, setPositionState] = useState(0);

  const setPosition = useCallback((percentage: number) => {
    setPositionState(Math.max(0, Math.min(100, percentage)));
  }, []);

  const setPreferences = useCallback((patch: Partial<ReaderPreferences>) => {
    setPreferencesState((current) => ({ ...current, ...patch }));
    if (patch.theme !== undefined) setThemePinned(true);
  }, []);

  // While unpinned the surface tracks the global theme; derived rather than
  // stored, so a live flip re-maps it without effects or subscriptions.
  const effectivePreferences = useMemo(
    () => (themePinned ? preferences : { ...preferences, theme: autoReaderTheme(globalTheme) }),
    [preferences, themePinned, globalTheme],
  );

  const value = useMemo(
    () => ({ preferences: effectivePreferences, position, setPosition, setPreferences }),
    [effectivePreferences, position, setPosition, setPreferences],
  );

  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>;
}
