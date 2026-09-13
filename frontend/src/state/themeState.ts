import { createContext, useContext } from "react";
import type { AppThemePreference, ResolvedTheme } from "@/lib/theme";

export interface ThemeState {
  /** What the user picked; "system" follows the OS setting live. */
  preference: AppThemePreference;
  /** The theme actually painted: the preference with "system" resolved. */
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: AppThemePreference) => void;
}

export const ThemeStateContext = createContext<ThemeState | null>(null);

export function useThemeState(): ThemeState {
  const state = useContext(ThemeStateContext);
  if (!state) {
    throw new Error("useThemeState must be used within ThemeStateProvider");
  }
  return state;
}
