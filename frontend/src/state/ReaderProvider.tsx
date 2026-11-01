import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { autoReaderTheme, ReaderContext, type ReaderPreferences } from "./readerState";
import {
  applyReaderSettingsPatch,
  readReaderSettings,
  subscribeReaderSettings,
  writeReaderSettings,
} from "@/lib/readerSettings";
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
 * Preferences come from the shared localStorage-backed store
 * (`lib/readerSettings`), so Settings edits and reader edits cannot leave
 * stale copies that overwrite each other. Position is persisted through the
 * backend progress commands and annotations (bookmarks, highlights, notes)
 * through the annotations commands.
 */
export function ReaderProvider({ children, globalTheme = "light" }: ReaderProviderProps) {
  const stored = useSyncExternalStore(
    subscribeReaderSettings,
    readReaderSettings,
    readReaderSettings,
  );
  const { preferences, themePinned } = stored;
  const [position, setPositionState] = useState(0);

  const setPosition = useCallback((percentage: number) => {
    setPositionState(Math.max(0, Math.min(100, percentage)));
  }, []);

  const effectiveTheme = themePinned ? preferences.theme : autoReaderTheme(globalTheme);

  const setPreferences = useCallback(
    (patch: Partial<ReaderPreferences>) => {
      writeReaderSettings(applyReaderSettingsPatch(readReaderSettings(), patch, globalTheme));
    },
    [globalTheme],
  );

  // While unpinned the surface tracks the global theme; derived rather than
  // stored, so a live flip re-maps it without effects or subscriptions.
  const effectivePreferences = useMemo(
    () => (themePinned ? preferences : { ...preferences, theme: effectiveTheme }),
    [preferences, themePinned, effectiveTheme],
  );

  const value = useMemo(
    () => ({ preferences: effectivePreferences, position, setPosition, setPreferences }),
    [effectivePreferences, position, setPosition, setPreferences],
  );

  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>;
}
