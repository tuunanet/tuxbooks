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
 * Nearest value from a supported scale (ties round down). Sliders and state
 * only ever hold scale steps; this snaps off-scale values (e.g. from a
 * future persistence format) back onto the scale.
 */
export function nearestEpubScaleStep<T extends number>(scale: readonly T[], value: number): T {
  let nearest: T = scale[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const step of scale) {
    const distance = Math.abs(value - step);
    if (distance < bestDistance) {
      nearest = step;
      bestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Nearest supported font-size step (ties round down). The slider and the
 * state only ever hold scale steps; this snaps off-scale values (e.g. from
 * a future persistence format) back onto the scale.
 */
export function nearestEpubFontSize(value: number): EpubFontSizeStep {
  return nearestEpubScaleStep(EPUB_FONT_SIZE_SCALE_PERCENT, value);
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

/**
 * Nearest supported line-height step (ties round down).
 */
export function nearestEpubLineHeight(value: number): EpubLineHeightStep {
  return nearestEpubScaleStep(EPUB_LINE_HEIGHT_SCALE, value);
}

/**
 * Converts a spacing scale step into the toolkit's preference: the 0
 * sentinel maps to null ("no preference", publisher value wins). A literal
 * 0 must never be sent for any `--USER__*` spacing — ReadiumCSS applies the
 * variable with `!important`, so `0rem` would override the publication's
 * own word/letter/paragraph spacing instead of leaving it intact.
 */
export function epubSpacingPreference(step: number): number | null {
  return step === 0 ? null : step;
}

/**
 * Word-spacing scale in rem (issue #45): the toolkit's
 * `wordSpacingRangeConfig` ([0, 2] step 0.125). 0 = publication default.
 */
export const EPUB_WORD_SPACING_SCALE = [
  0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25, 1.375, 1.5, 1.625, 1.75, 1.875, 2,
] as const;

/** Nearest supported word-spacing step. */
export function nearestEpubWordSpacing(value: number): number {
  return nearestEpubScaleStep(EPUB_WORD_SPACING_SCALE, value);
}

/**
 * Letter-spacing scale in rem (issue #45): the toolkit's
 * `letterSpacingRangeConfig` ([0, 1] step 0.125). 0 = publication default.
 */
export const EPUB_LETTER_SPACING_SCALE = [
  0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1,
] as const;

/** Nearest supported letter-spacing step. */
export function nearestEpubLetterSpacing(value: number): number {
  return nearestEpubScaleStep(EPUB_LETTER_SPACING_SCALE, value);
}

/**
 * Paragraph-spacing scale in rem (issue #45): the toolkit's
 * `paragraphSpacingRangeConfig` ([0, 3] step 0.25). 0 = publication
 * default.
 */
export const EPUB_PARAGRAPH_SPACING_SCALE = [
  0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3,
] as const;

/** Nearest supported paragraph-spacing step. */
export function nearestEpubParagraphSpacing(value: number): number {
  return nearestEpubScaleStep(EPUB_PARAGRAPH_SPACING_SCALE, value);
}

/**
 * Page-margin (gutter) scale in px (issue #45). The toolkit exposes no
 * range config for `pageGutter` (unbounded non-negative px applied as body
 * padding in paginated flow), so this ladder is a deliberate TuxBooks
 * product decision (issue #45 contract). 0 = publication default.
 */
export const EPUB_PAGE_GUTTER_SCALE_PX = [0, 10, 20, 30, 40, 60] as const;

/** Nearest supported page-margin step. */
export function nearestEpubPageGutter(value: number): number {
  return nearestEpubScaleStep(EPUB_PAGE_GUTTER_SCALE_PX, value);
}

/**
 * Text alignment values (issue #45). "auto" is the reading-system's
 * publisher-default state; the explicit choices are exactly the toolkit's
 * `TextAlignment` enum. The seam maps "auto" to the toolkit's "no
 * preference" — never the string "auto", which the toolkit would drop and
 * whose CSS (`text-align: auto !important`) would be invalid.
 */
export const EPUB_TEXT_ALIGNMENTS = ["auto", "left", "justify", "right", "start"] as const;

export type EpubTextAlignment = (typeof EPUB_TEXT_ALIGNMENTS)[number];

/** The default alignment: publisher behavior (no override). */
export const EPUB_DEFAULT_TEXT_ALIGNMENT: EpubTextAlignment = "auto";

/**
 * Converts a reader alignment choice into the toolkit's textAlign
 * preference: the "auto" sentinel maps to null so publisher alignment
 * (including centered headings etc.) stays intact; only an explicit choice
 * overrides.
 */
export function epubTextAlignPreference(
  alignment: EpubTextAlignment | null,
): "start" | "left" | "right" | "justify" | null {
  return alignment === null || alignment === "auto" ? null : alignment;
}

/**
 * Reader themes (issue #46), following the reading-system model: the
 * toolkit has no named-theme preference — themes are presets over the six
 * color preferences (background, text, link, visited, selection pair), the
 * same vocabulary the reference implementation maps in
 * `computeReadiumCssJsonMessage`. `default` is the neutral state: it
 * submits no colors at all, so publisher styling (including link and
 * selection colors) stays intact.
 */
export type EpubThemeName =
  "default" | "light" | "paper" | "dark" | "contrast" | "blue-contrast" | "mint-contrast";

/** The default theme: neutral (no color override). */
export const EPUB_DEFAULT_THEME: EpubThemeName = "default";

/** Full color vocabulary a themed preset must provide (issue #46). */
export interface EpubThemeColors {
  background: string;
  text: string;
  link: string;
  visited: string;
  selectionBackground: string;
  selectionText: string;
}

/**
 * Theme presets. Light/Paper/Dark keep their established values, completed
 * with visited + selection colors. The contrast presets adapt the
 * reference's accessibility set (contrast2/3/4); where the reference's
 * pairs fall short of WCAG AA (its #0000ee links on black measure ≈2:1),
 * the foregrounds are corrected — unit tests enforce ≥ 4.5:1 for every
 * text/link/visited/selection pair, so this table cannot silently regress.
 */
export const EPUB_THEME_COLORS: Record<Exclude<EpubThemeName, "default">, EpubThemeColors> = {
  light: {
    background: "#ffffff",
    text: "#1f2328",
    link: "#0b62c4",
    visited: "#551a8b",
    selectionBackground: "#86b6fe",
    selectionText: "#1f2328",
  },
  paper: {
    background: "#f6f0e4",
    text: "#3a332a",
    link: "#7c5b2a",
    visited: "#551a8b",
    selectionBackground: "#86b6fe",
    selectionText: "#3a332a",
  },
  dark: {
    background: "#101013",
    text: "#e4e4e7",
    link: "#7ab7ff",
    visited: "#c3b0f5",
    selectionBackground: "#4a5f9e",
    selectionText: "#ffffff",
  },
  contrast: {
    background: "#000000",
    text: "#ffff00",
    link: "#66b2ff",
    visited: "#c5a3e0",
    selectionBackground: "#4a5f9e",
    selectionText: "#ffffff",
  },
  "blue-contrast": {
    background: "#181842",
    text: "#ffffff",
    link: "#7ab7ff",
    visited: "#c5a3e0",
    selectionBackground: "#4a5f9e",
    selectionText: "#ffffff",
  },
  "mint-contrast": {
    background: "#c5e7cd",
    text: "#000000",
    link: "#0000ee",
    visited: "#551a8b",
    selectionBackground: "#86b6fe",
    selectionText: "#000000",
  },
};

/**
 * Colors a theme submits to the toolkit; null for the neutral default
 * (whose nulls actively clear a previously applied theme — the toolkit's
 * preference merging copies nulls and skips undefined).
 */
export function epubThemeColors(theme: EpubThemeName): EpubThemeColors | null {
  return theme === "default" ? null : EPUB_THEME_COLORS[theme];
}

/**
 * Background the app paints around/beside the reading surface so the
 * engine surface and the shell are seamless. The neutral default bridges
 * nothing (the app surface shows, publisher colors own the content).
 */
export function epubThemeBackground(theme: EpubThemeName): string | undefined {
  return epubThemeColors(theme)?.background;
}

/**
 * Scrollbar colors for the reading surface's scroller: a translucent thumb
 * derived from the theme's own text color over a transparent track (the
 * themed chrome shows through). Both values are required — a single-color
 * scrollbar-color declaration is invalid. The neutral default keeps the
 * native scrollbar; every preset themes it to match its surface.
 */
export function readerScrollbarColor(theme: EpubThemeName): string | undefined {
  const colors = epubThemeColors(theme);
  if (!colors || !/^#[0-9a-f]{6}$/i.test(colors.text)) return undefined;
  const value = colors.text.slice(1);
  const channel = (offset: number) => parseInt(value.slice(offset, offset + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, 0.4) transparent`;
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
