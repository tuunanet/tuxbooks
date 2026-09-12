/**
 * EPUB font-size scale (docs/EPUB.md, issue #42). The reader stores the user
 * font size as a percentage of the publication's default reading size
 * (100% = native), following the Readium reading-system model — never as an
 * absolute px value. The Readium toolkit's `EpubPreferences.fontSize` is a
 * unitless multiplier of the publication default (accepted range [0.7, 4]);
 * the percent→ratio conversion happens only here, at the engine boundary.
 * This module is pure so the scale and mapping are unit-testable without
 * loading the engine.
 */

/** Readium's accepted fontSize ratio range (`fontSizeRangeConfig.range`). */
export const EPUB_FONT_RATIO_RANGE = [0.7, 4] as const;

/**
 * Supported font sizes, in percent of the publication default. The values
 * through 250% are the standard Readium reading-system scale (the reference
 * implementation's `options-values.ts` ladder); 275–400% extend the same
 * coarse-tail pattern to the toolkit's accepted maximum. Every value maps
 * inside EPUB_FONT_RATIO_RANGE.
 */
export const EPUB_FONT_SIZE_SCALE_PERCENT = [
  75, 87.5, 100, 112.5, 137.5, 150, 162.5, 175, 200, 225, 250, 275, 300, 350, 400,
] as const;

export type EpubFontSizeStep = (typeof EPUB_FONT_SIZE_SCALE_PERCENT)[number];

/** The default reading size: the publication's native (100%). */
export const EPUB_DEFAULT_FONT_SIZE_PERCENT: EpubFontSizeStep = 100;

/** Converts a scale percentage into Readium's unitless fontSize ratio. */
export function epubFontSizeRatio(percent: number): number {
  return percent / 100;
}

/** True when `value` is exactly a supported scale step. */
export function isEpubFontSizeStep(value: number): value is EpubFontSizeStep {
  return (EPUB_FONT_SIZE_SCALE_PERCENT as readonly number[]).includes(value);
}

/**
 * Nearest supported scale step (ties round down). The slider and the state
 * only ever hold scale steps; this snaps off-scale values (e.g. from a
 * future persistence format) back onto the scale.
 */
export function nearestEpubFontSize(value: number): EpubFontSizeStep {
  let nearest: EpubFontSizeStep = EPUB_DEFAULT_FONT_SIZE_PERCENT;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const step of EPUB_FONT_SIZE_SCALE_PERCENT) {
    const distance = Math.abs(value - step);
    if (distance < bestDistance) {
      nearest = step;
      bestDistance = distance;
    }
  }
  return nearest;
}
