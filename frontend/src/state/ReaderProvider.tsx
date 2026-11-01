import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ReaderContext, type ReaderPreferences } from "./readerState";
import {
  applyReaderSettingsPatch,
  effectiveReaderTheme,
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
  const { preferences } = stored;
  const effectiveTheme = effectiveReaderTheme(stored, globalTheme);
  const [position, setPositionState] = useState(0);

  const setPosition = useCallback((percentage: number) => {
    setPositionState(Math.max(0, Math.min(100, percentage)));
  }, []);

  const setPreferences = useCallback(
    (patch: Partial<ReaderPreferences>) => {
      writeReaderSettings(applyReaderSettingsPatch(readReaderSettings(), patch, globalTheme));
    },
    [globalTheme],
  );

  // `preferences` keeps the menu selection (Default included); the surface
  // theme is applied separately so Default can follow the app theme without
  // changing what the appearance menu shows as selected.
  const value = useMemo(
    () => ({ preferences, effectiveTheme, position, setPosition, setPreferences }),
    [preferences, effectiveTheme, position, setPosition, setPreferences],
  );

  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>;
}
