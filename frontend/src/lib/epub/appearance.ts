/**
 * EPUB appearance mapping (docs/EPUB.md). The reader stores the user font
 * size as a percentage of the publication's default reading size (100% =
 * native) and the line height on a discrete reading-system scale (0 =
 * publication default), following the Readium reading-system model — never
 * arbitrary px/unitless values. The Readium toolkit's `EpubPreferences`
 * takes a unitless fontSize multiplier (accepted range [0.7, 4]), a unitless
 * lineHeight (null = no override), and an explicit columnCount target for
 * paginated reflow; the percent→ratio, 0→null, and fixed-layout gating
 * conversions happen only here, at the engine boundary. This module
 * is pure so the scales and mapping are unit-testable without loading the
 * engine.
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
 * Nearest supported font-size step (ties round down). The slider and the
 * state only ever hold scale steps; this snaps off-scale values (e.g. from
 * a future persistence format) back onto the scale.
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

/**
 * Reader font families, following the ReadiumCSS reading-system model. The
 * ReadiumCSS stacks are `var(--RS__…Tf)` references resolved inside each
 * section frame, so they track the reading system's per-direction stacks
 * instead of hard-coded app CSS. Duospace and Readable use the same family
 * names the reference implementation injects ("IA Writer Duospace",
 * "AccessibleDfA"); until the font files ship with the app they degrade to
 * intent-preserving fallback stacks when not installed on the system.
 */
export const EPUB_FONT_FAMILIES = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "var(--RS__sansTf)",
  humanist: "var(--RS__humanistTf)",
  "old-style": "var(--RS__oldStyleTf)",
  modern: "var(--RS__modernTf)",
  duospace:
    '"IA Writer Duospace", "SF Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
  readable: '"AccessibleDfA", Verdana, Tahoma, "Comic Sans MS", sans-serif',
} as const;

export type EpubFontFamily = keyof typeof EPUB_FONT_FAMILIES;

/**
 * Converts a reader font choice into the toolkit's fontFamily preference.
 * Default (null) must map to null — the toolkit then writes no
 * `--USER__fontFamily`, so publisher styling (including embedded @font-face
 * faces) stays intact; only an explicit choice overrides it.
 */
export function epubFontFamilyPreference(fontFamily: EpubFontFamily | null): string | null {
  return fontFamily === null ? null : EPUB_FONT_FAMILIES[fontFamily];
}

/**
 * Discrete line-height scale (issue #43): the reading-system values, with
 * 0 as the publication-default sentinel (no user override).
 */
export const EPUB_LINE_HEIGHT_SCALE = [0, 1, 1.125, 1.25, 1.35, 1.5, 1.65, 1.75, 2] as const;

export type EpubLineHeightStep = (typeof EPUB_LINE_HEIGHT_SCALE)[number];

/** The default line height: publication behavior (no override). */
export const EPUB_DEFAULT_LINE_HEIGHT: EpubLineHeightStep = 0;

/**
 * Converts a scale step into the toolkit's lineHeight preference: the 0
 * sentinel maps to null ("no preference", publisher line-height wins).
 * A literal 0 must never reach the toolkit — `--USER__lineHeight: 0`
 * computes `line-height: 0 !important` and collapses text.
 */
export function epubLineHeightPreference(step: number): number | null {
  return step === 0 ? null : step;
}

/** Nearest supported line-height step (ties round down). */
export function nearestEpubLineHeight(value: number): EpubLineHeightStep {
  let nearest: EpubLineHeightStep = EPUB_DEFAULT_LINE_HEIGHT;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const step of EPUB_LINE_HEIGHT_SCALE) {
    const distance = Math.abs(value - step);
    if (distance < bestDistance) {
      nearest = step;
      bestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Column-count targets for paginated EPUB reflow (issue #44). The selected
 * value is an explicit target, not an auto-fit hint: ReadiumCSS paginates
 * exactly N columns whenever the viewport fits N columns at the minimal
 * readable line length and never silently falls back to an automatic count
 * when width exists (ReadiumCSS `paginate()`: `columnCount > 1` → N columns;
 * `1` → exactly one column; absent → viewport-dependent auto-fit, the
 * behavior this setting replaces).
 */
export const EPUB_COLUMN_COUNTS = [1, 2, 3, 4] as const;

export type EpubColumnCount = (typeof EPUB_COLUMN_COUNTS)[number];

/**
 * The default column count: the two-page spread, the common reading
 * convention. On windows too narrow for two columns the toolkit floors to
 * what fits (one column), without changing the stored preference.
 */
export const EPUB_DEFAULT_COLUMN_COUNT: EpubColumnCount = 2;

/** True when `value` is exactly a supported column count. */
export function isEpubColumnCount(value: number): value is EpubColumnCount {
  return (EPUB_COLUMN_COUNTS as readonly number[]).includes(value);
}

/**
 * Clamps an off-scale value (e.g. from a future stored preference) onto the
 * supported 1–4 range so a stale value can never produce an invalid target.
 */
export function clampEpubColumnCount(value: number): EpubColumnCount {
  return Math.min(4, Math.max(1, Math.round(value))) as EpubColumnCount;
}

/** Publication layout reported by the engine (drives the column-count gate). */
export type EpubDocumentLayout = "fixed" | "reflowable" | "scrolled";

/**
 * Converts the reader's column choice into the toolkit's columnCount
 * preference. Fixed-layout publications must never receive it: FXL has its
 * own pages-per-view behavior (`setPerPage`) that a reflow column target
 * must not touch (issue #44). Reflowable and scrolled documents pass the
 * value through — scrolled flow ignores it by construction.
 */
export function epubColumnCountPreference(
  layout: EpubDocumentLayout,
  columnCount: number,
): number | undefined {
  return layout === "fixed" ? undefined : clampEpubColumnCount(columnCount);
}
