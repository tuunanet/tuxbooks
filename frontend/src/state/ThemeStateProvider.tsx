import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyTheme,
  parseStoredTheme,
  resolveTheme,
  subscribeToSystemTheme,
  systemPrefersDark,
  THEME_STORAGE_KEY,
  type AppThemePreference,
} from "@/lib/theme";
import { ThemeStateContext, type ThemeState } from "./themeState";

function readStoredPreference(): AppThemePreference {
  try {
    return parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Storage unavailable (exotic embed contexts): the theme is cosmetic,
    // follow the system for the session instead of failing.
    return "system";
  }
}

export function ThemeStateProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<AppThemePreference>(readStoredPreference);
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark(window));
  const resolvedTheme = resolveTheme(preference, systemDark);

  // Paint (and repaint) the resolved theme; idempotent, so StrictMode's
  // double mount is harmless.
  useEffect(() => {
    applyTheme(resolvedTheme, document);
  }, [resolvedTheme]);

  // Live OS flips matter only while the preference is "system".
  useEffect(() => {
    if (preference !== "system") return;
    return subscribeToSystemTheme(window, setSystemDark);
  }, [preference]);

  const setPreference = useCallback((next: AppThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice holds for this session only.
    }
    // systemDark may be stale after OS flips that happened while pinned to
    // an explicit theme; re-read when returning to "system".
    if (next === "system") setSystemDark(systemPrefersDark(window));
  }, []);

  const value = useMemo<ThemeState>(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return <ThemeStateContext.Provider value={value}>{children}</ThemeStateContext.Provider>;
}
