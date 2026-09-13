/**
 * Global app theme (light/dark) — independent of the reader-internal themes
 * (ReaderTheme, PDF theme), which stay session-scoped to the reading surface.
 * Pure logic plus the one DOM touchpoint; React wiring lives in
 * state/ThemeStateProvider.tsx and the pre-bundle bootstrap in index.html
 * mirrors applyTheme to avoid a flash of the wrong theme at startup.
 */

export type AppThemePreference = "system" | "light" | "dark";

export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "tuxbooks.theme";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

const PREFERENCES: readonly AppThemePreference[] = ["system", "light", "dark"];

/** Missing or unrecognized stored values fall back to following the OS. */
export function parseStoredTheme(raw: string | null): AppThemePreference {
  return PREFERENCES.find((preference) => preference === raw) ?? "system";
}

export function resolveTheme(preference: AppThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/**
 * Class-based dark mode (see `@custom-variant dark` in index.css) plus
 * `color-scheme`, which switches the native scrollbars, form controls, and
 * dialogs along with the palette.
 */
export function applyTheme(theme: ResolvedTheme, doc: Document): void {
  doc.documentElement.classList.toggle("dark", theme === "dark");
  doc.documentElement.style.colorScheme = theme;
}

export function systemPrefersDark(win: Window): boolean {
  const media = win.matchMedia?.(DARK_MEDIA_QUERY);
  return media?.matches ?? false;
}

/**
 * Subscribes to live OS theme flips; returns the unsubscribe function.
 * Callers are expected to subscribe only while the preference is "system".
 */
export function subscribeToSystemTheme(
  win: Window,
  onChange: (systemDark: boolean) => void,
): () => void {
  const media = win.matchMedia?.(DARK_MEDIA_QUERY);
  if (!media) return () => {};
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
