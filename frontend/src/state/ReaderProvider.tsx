import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { autoReaderTheme, ReaderContext, type ReaderPreferences } from "./readerState";
import { epubForegroundFitsTheme } from "@/lib/epub/appearance";
import { readReaderSettings, writeReaderSettings } from "@/lib/readerSettings";
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
  // Seed from the persisted defaults once; the effect below writes every
  // change back, so appearance picks apply to the next book too.
  const [initial] = useState(readReaderSettings);
  const [preferences, setPreferencesState] = useState<ReaderPreferences>(initial.preferences);
  const [themePinned, setThemePinned] = useState(initial.themePinned);
  const [position, setPositionState] = useState(0);

  useEffect(() => {
    writeReaderSettings({ preferences, themePinned });
  }, [preferences, themePinned]);

  const setPosition = useCallback((percentage: number) => {
    setPositionState(Math.max(0, Math.min(100, percentage)));
  }, []);

  const effectiveTheme = themePinned ? preferences.theme : autoReaderTheme(globalTheme);

  const setPreferences = useCallback(
    (patch: Partial<ReaderPreferences>) => {
      setPreferencesState((current) => {
        const next = { ...current, ...patch };
        // A foreground override is judged against the theme it was picked
        // on; switching to a theme whose surface it no longer fits (WCAG
        // AA) drops it instead of coloring body text illegibly (UAT:
        // bright ink from Dark surviving a switch to the white Default
        // page). The comparison uses the effective surface — while
        // unpinned that is the auto theme, not the stored one. OS flips
        // while unpinned do not pass through here and keep the
        // session-scoped override as-is.
        const currentEffectiveTheme = themePinned ? current.theme : autoReaderTheme(globalTheme);
        if (
          patch.theme !== undefined &&
          patch.theme !== currentEffectiveTheme &&
          !epubForegroundFitsTheme(next.foreground, next.theme)
        ) {
          next.foreground = null;
        }
        return next;
      });
      if (patch.theme !== undefined) setThemePinned(true);
    },
    [globalTheme, themePinned],
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
