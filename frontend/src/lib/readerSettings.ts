/**
 * Persisted reader-appearance defaults (Settings → Viewer settings).
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
  EPUB_THEME_NAMES,
  EPUB_TEXT_ALIGNMENTS,
  epubForegroundFitsTheme,
  epubSurfaceTheme,
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
import { sanitizeHighlightOverrides } from "@/lib/highlightPalette";

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

// EPUB presets come from the palette; Invert is the PDF-only extra.
const THEMES: readonly ReaderTheme[] = [...EPUB_THEME_NAMES, "invert"];

const LAYOUTS: readonly ReaderLayout[] = ["paginated", "scrolling"];

export function defaultReaderSettings(): StoredReaderSettings {
  return { preferences: DEFAULT_READER_PREFERENCES, themePinned: false };
}

/** Stable snapshot for the no-storage path `useSyncExternalStore` reads. */
const NO_STORAGE_SETTINGS = defaultReaderSettings();

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
    highlightOverrides: sanitizeHighlightOverrides(source.highlightOverrides),
    theme,
    layout,
    // Booleans are never trusted verbatim: only a stored literal true
    // sticks, anything malformed sanitizes back to the off default
    // (the themePinned precedent in readReaderSettings).
    bookMode: source.bookMode === true,
  };
}

/** Cached snapshot so `useSyncExternalStore` sees a stable object per value. */
let cachedRaw: string | null | undefined;
let cachedSettings: StoredReaderSettings | undefined;
/** Session override for unavailable or full storage. */
let sessionSettings: StoredReaderSettings | undefined;
const listeners = new Set<() => void>();

function parseStored(raw: string | null): StoredReaderSettings {
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

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribe to reader-setting writes. The reader and Settings both consume
 * the same localStorage-backed store, so a change in one surface repaints the
 * other instead of leaving a stale copy that can overwrite it later.
 */
export function subscribeReaderSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read the stored settings, defaulting on absence, corruption, or no storage. */
export function readReaderSettings(): StoredReaderSettings {
  if (sessionSettings) return sessionSettings;
  const storage = safeStorage();
  if (!storage) return NO_STORAGE_SETTINGS;
  const raw = storage.getItem(READER_SETTINGS_STORAGE_KEY);
  if (raw === cachedRaw && cachedSettings) return cachedSettings;
  cachedRaw = raw;
  cachedSettings = parseStored(raw);
  return cachedSettings;
}

export function writeReaderSettings(settings: StoredReaderSettings): void {
  const storage = safeStorage();
  if (!storage) {
    sessionSettings = settings;
    emit();
    return;
  }
  try {
    const raw = JSON.stringify(settings);
    storage.setItem(READER_SETTINGS_STORAGE_KEY, raw);
    sessionSettings = undefined;
    cachedRaw = raw;
    cachedSettings = parseStored(raw);
    emit();
  } catch {
    // Storage full: preferences stay session-scoped instead of failing.
    sessionSettings = settings;
    emit();
  }
}

export function clearReaderSettings(): void {
  sessionSettings = undefined;
  const storage = safeStorage();
  if (!storage) {
    emit();
    return;
  }
  try {
    storage.removeItem(READER_SETTINGS_STORAGE_KEY);
    cachedRaw = null;
    cachedSettings = defaultReaderSettings();
    emit();
  } catch {
    // Nothing to clear.
  }
}

/**
 * Apply one appearance patch on top of the stored settings. An explicit
 * theme pick pins the surface, and a foreground override that would fail AA
 * on the new theme surface is dropped instead of coloring body text
 * illegibly. Both the reader and Settings go through this one rule.
 */
export function applyReaderSettingsPatch(
  current: StoredReaderSettings,
  patch: Partial<ReaderPreferences>,
  resolvedTheme: ResolvedTheme,
): StoredReaderSettings {
  const preferences = { ...current.preferences, ...patch };
  const next: StoredReaderSettings = {
    preferences,
    themePinned: patch.theme !== undefined ? true : current.themePinned,
  };
  const currentEffective = effectiveReaderTheme(current, resolvedTheme);
  const nextEffective = effectiveReaderTheme(next, resolvedTheme);
  if (
    patch.theme !== undefined &&
    nextEffective !== currentEffective &&
    // The fit check uses the EPUB-facing surface of the applied theme (the
    // PDF-only Invert preset degrades to dark — issue #67).
    !epubForegroundFitsTheme(preferences.foreground, epubSurfaceTheme(nextEffective))
  ) {
    preferences.foreground = null;
  }
  return next;
}

/**
 * The theme the reader actually paints. Default follows the app theme, so a
 * dark app keeps the book dark unless an explicit preset overrides it; light
 * apps keep publisher colors for Default.
 */
export function effectiveReaderTheme(
  settings: StoredReaderSettings,
  resolved: ResolvedTheme,
): ReaderTheme {
  return settings.themePinned && settings.preferences.theme !== "default"
    ? settings.preferences.theme
    : autoReaderTheme(resolved);
}

/**
 * The preferences the reader surface should actually apply. The stored theme
 * selection stays available for the appearance menu; only the applied theme
 * is swapped for the auto value.
 */
export function effectiveReaderPreferences(
  settings: StoredReaderSettings,
  resolved: ResolvedTheme,
): ReaderPreferences {
  return { ...settings.preferences, theme: effectiveReaderTheme(settings, resolved) };
}
