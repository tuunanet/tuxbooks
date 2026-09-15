/**
 * Persisted reader-appearance defaults (Settings → Reading / PDF).
 *
 * Reader preferences used to reset with every reader session. They are now
 * saved on device so a chosen font, spacing, theme, or layout applies to the
 * next book too. The reader surface writes here whenever a preference
 * changes; Settings edits the same store directly. The app theme follows the
 * same device-local model (`lib/theme.ts`).
 *
 * The stored shape is validated and snapped back onto the supported scales on
 * read, so a stale or hand-edited value can never wedge a control or reach the
 * rendering engine. Nothing here is React-specific; the provider owns state.
 */

import {
  clampEpubColumnCount,
  EPUB_FONT_FAMILIES,
  EPUB_TEXT_ALIGNMENTS,
  isEpubHexColor,
  nearestEpubFontSize,
  nearestEpubLetterSpacing,
  nearestEpubLineHeight,
  nearestEpubPageGutter,
  nearestEpubParagraphSpacing,
  nearestEpubWordSpacing,
  type EpubFontFamily,
  type EpubTextAlignment,
  type ReaderTheme,
} from "@/lib/epub/appearance";
import type { ResolvedTheme } from "@/lib/theme";
import {
  autoReaderTheme,
  DEFAULT_READER_PREFERENCES,
  type ReaderLayout,
  type ReaderPreferences,
} from "@/state/readerState";

export const READER_SETTINGS_STORAGE_KEY = "tuxbooks.reader";

/** Persisted preferences plus whether the user pinned a reader theme. */
export interface StoredReaderSettings {
  preferences: ReaderPreferences;
  /**
   * True once the user picked a reader theme. While false the surface keeps
   * following the global app theme (light → publisher colors, dark → dark
   * preset); an explicit "Default" pick pins it like any other.
   */
  themePinned: boolean;
}

const THEMES: readonly ReaderTheme[] = [
  "default",
  "light",
  "paper",
  "dark",
  "contrast",
  "invert",
  "blue-contrast",
  "mint-contrast",
];

const LAYOUTS: readonly ReaderLayout[] = ["paginated", "scrolling"];

export function defaultReaderSettings(): StoredReaderSettings {
  return { preferences: DEFAULT_READER_PREFERENCES, themePinned: false };
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Validate a raw stored preferences object, snapping values onto the scales. */
export function sanitizeReaderPreferences(raw: unknown): ReaderPreferences {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const defaults = DEFAULT_READER_PREFERENCES;

  const theme = THEMES.includes(source.theme as ReaderTheme)
    ? (source.theme as ReaderTheme)
    : defaults.theme;
  const layout = LAYOUTS.includes(source.layout as ReaderLayout)
    ? (source.layout as ReaderLayout)
    : defaults.layout;
  const textAlign = (EPUB_TEXT_ALIGNMENTS as readonly unknown[]).includes(source.textAlign)
    ? (source.textAlign as EpubTextAlignment)
    : defaults.textAlign;
  const fontFamily =
    typeof source.fontFamily === "string" && source.fontFamily in EPUB_FONT_FAMILIES
      ? (source.fontFamily as EpubFontFamily)
      : null;
  const foreground =
    typeof source.foreground === "string" && isEpubHexColor(source.foreground)
      ? source.foreground.toLowerCase()
      : null;

  return {
    epubFontSize: nearestEpubFontSize(asNumber(source.epubFontSize, defaults.epubFontSize)),
    lineHeight: nearestEpubLineHeight(asNumber(source.lineHeight, defaults.lineHeight)),
    fontFamily,
    columnCount: clampEpubColumnCount(asNumber(source.columnCount, defaults.columnCount)),
    wordSpacing: nearestEpubWordSpacing(asNumber(source.wordSpacing, defaults.wordSpacing)),
    letterSpacing: nearestEpubLetterSpacing(asNumber(source.letterSpacing, defaults.letterSpacing)),
    paragraphSpacing: nearestEpubParagraphSpacing(
      asNumber(source.paragraphSpacing, defaults.paragraphSpacing),
    ),
    pageGutter: nearestEpubPageGutter(asNumber(source.pageGutter, defaults.pageGutter)),
    textAlign,
    foreground,
    theme,
    layout,
  };
}

/** Read the stored settings, defaulting on absence, corruption, or no storage. */
export function readReaderSettings(): StoredReaderSettings {
  const storage = safeStorage();
  if (!storage) return defaultReaderSettings();
  const raw = storage.getItem(READER_SETTINGS_STORAGE_KEY);
  if (!raw) return defaultReaderSettings();
  try {
    const parsed = JSON.parse(raw) as { preferences?: unknown; themePinned?: unknown };
    return {
      preferences: sanitizeReaderPreferences(parsed?.preferences),
      themePinned: parsed?.themePinned === true,
    };
  } catch {
    return defaultReaderSettings();
  }
}

export function writeReaderSettings(settings: StoredReaderSettings): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(READER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or unavailable: preferences stay session-scoped.
  }
}

export function clearReaderSettings(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(READER_SETTINGS_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The preferences the reader surface should actually apply: while the theme
 * is unpinned the surface follows the resolved global theme, otherwise the
 * stored explicit theme wins.
 */
export function effectiveReaderPreferences(
  settings: StoredReaderSettings,
  resolved: ResolvedTheme,
): ReaderPreferences {
  return settings.themePinned
    ? settings.preferences
    : { ...settings.preferences, theme: autoReaderTheme(resolved) };
}
