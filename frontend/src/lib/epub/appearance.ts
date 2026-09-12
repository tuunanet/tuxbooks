/**
 * EPUB appearance mapping (docs/EPUB.md). The reader stores the user font
 * size in CSS pixels, but the Readium toolkit's `EpubPreferences.fontSize`
 * is a unitless multiplier of the publication's default (1 = 100%, accepted
 * range [0.7, 4]) — a px value is silently dropped by the preferences
 * validation. This module is pure so the mapping is unit-testable without
 * loading the engine.
 */

/**
 * The px size that maps to Readium's 1.0 — the app's default reading size.
 * `DEFAULT_READER_PREFERENCES.fontSize` (frontend/src/state/readerState.ts)
 * is defined as this constant, so the default and the conversion cannot
 * drift apart.
 */
export const EPUB_BASE_FONT_PX = 17;

/** Readium's accepted fontSize ratio range (`fontSizeRangeConfig.range`). */
export const EPUB_FONT_RATIO_RANGE = [0.7, 4] as const;

/** Converts a UI px font size into Readium's unitless fontSize ratio. */
export function epubFontSizeRatio(px: number): number {
  return px / EPUB_BASE_FONT_PX;
}
