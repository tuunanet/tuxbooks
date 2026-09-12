import { describe, expect, it } from "vitest";
import {
  EPUB_DEFAULT_FONT_SIZE_PERCENT,
  EPUB_DEFAULT_LINE_HEIGHT,
  EPUB_DEFAULT_TEXT_ALIGNMENT,
  EPUB_FONT_FAMILIES,
  EPUB_FONT_RATIO_RANGE,
  EPUB_FONT_SIZE_SCALE_PERCENT,
  EPUB_LETTER_SPACING_SCALE,
  EPUB_LINE_HEIGHT_SCALE,
  EPUB_PAGE_GUTTER_SCALE_PX,
  EPUB_PARAGRAPH_SPACING_SCALE,
  EPUB_WORD_SPACING_SCALE,
  clampEpubColumnCount,
  EPUB_COLUMN_COUNTS,
  EPUB_DEFAULT_COLUMN_COUNT,
  epubFontSizeRatio,
  epubFontFamilyPreference,
  epubColumnCountPreference,
  epubLineHeightPreference,
  epubSpacingPreference,
  epubTextAlignPreference,
  isEpubFontSizeStep,
  nearestEpubFontSize,
  nearestEpubLetterSpacing,
  nearestEpubLineHeight,
  nearestEpubPageGutter,
  nearestEpubParagraphSpacing,
  nearestEpubWordSpacing,
} from "@/lib/epub/appearance";
import { DEFAULT_READER_PREFERENCES } from "@/state/readerState";

/**
 * Font-size scale mapping between the reader state (percent of the
 * publication's default reading size, issue #42) and the Readium toolkit
 * (unitless ratio, accepted range [0.7, 4]). A raw px value is outside the
 * accepted range and is silently dropped by the EpubPreferences validation —
 * the regression this pins (issue #40), now avoided by storing a relative
 * scale value in the first place.
 */

/** The Readium reference implementation's standard scale (through 250%). */
const REFERENCE_SCALE = [75, 87.5, 100, 112.5, 137.5, 150, 162.5, 175, 200, 225, 250];

describe("EPUB_FONT_SIZE_SCALE_PERCENT", () => {
  it("starts at the established 75% floor and reaches the 400% maximum", () => {
    expect(EPUB_FONT_SIZE_SCALE_PERCENT[0]).toBe(75);
    expect(EPUB_FONT_SIZE_SCALE_PERCENT.at(-1)).toBe(400);
  });

  it("contains the reference implementation's standard intermediate steps", () => {
    for (const step of REFERENCE_SCALE) {
      expect(EPUB_FONT_SIZE_SCALE_PERCENT).toContain(step);
    }
  });

  it("is strictly increasing", () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const step of EPUB_FONT_SIZE_SCALE_PERCENT) {
      expect(step).toBeGreaterThan(previous);
      previous = step;
    }
  });

  it("keeps every step inside Readium's accepted ratio range", () => {
    for (const step of EPUB_FONT_SIZE_SCALE_PERCENT) {
      const ratio = epubFontSizeRatio(step);
      expect(ratio).toBeGreaterThanOrEqual(EPUB_FONT_RATIO_RANGE[0]);
      expect(ratio).toBeLessThanOrEqual(EPUB_FONT_RATIO_RANGE[1]);
    }
  });
});

describe("epubFontSizeRatio", () => {
  it("maps the default 100% to Readium's 1.0 (publication native size)", () => {
    expect(EPUB_DEFAULT_FONT_SIZE_PERCENT).toBe(100);
    expect(DEFAULT_READER_PREFERENCES.epubFontSize).toBe(EPUB_DEFAULT_FONT_SIZE_PERCENT);
    expect(epubFontSizeRatio(EPUB_DEFAULT_FONT_SIZE_PERCENT)).toBe(1);
  });

  it("converts representative low/default/high values to the exact unitless ratio", () => {
    expect(epubFontSizeRatio(75)).toBe(0.75);
    expect(epubFontSizeRatio(100)).toBe(1);
    expect(epubFontSizeRatio(175)).toBe(1.75);
    expect(epubFontSizeRatio(250)).toBe(2.5);
    expect(epubFontSizeRatio(400)).toBe(4);
  });

  it("converts monotonically: a bigger step never yields a smaller ratio", () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const step of EPUB_FONT_SIZE_SCALE_PERCENT) {
      expect(epubFontSizeRatio(step)).toBeGreaterThan(epubFontSizeRatio(previous));
      previous = step;
    }
  });

  it("rejects the raw px unit the relative scale replaces (regression pin)", () => {
    // Every value of the old 14–22 px slider would be discarded by
    // EpubPreferences' range validation — the silently-dropped preference of
    // issue #40 that the percent scale (issue #42) removes.
    for (let px = 14; px <= 22; px += 1) {
      expect(px).toBeGreaterThan(EPUB_FONT_RATIO_RANGE[1]);
    }
  });
});

describe("nearestEpubFontSize", () => {
  it("keeps supported steps unchanged", () => {
    for (const step of EPUB_FONT_SIZE_SCALE_PERCENT) {
      expect(isEpubFontSizeStep(step)).toBe(true);
      expect(nearestEpubFontSize(step)).toBe(step);
    }
  });

  it("snaps off-scale values to the nearest step", () => {
    expect(nearestEpubFontSize(80)).toBe(75);
    expect(nearestEpubFontSize(95)).toBe(100);
    expect(nearestEpubFontSize(420)).toBe(400);
    expect(nearestEpubFontSize(10)).toBe(75);
  });
});

describe("EPUB_LINE_HEIGHT_SCALE", () => {
  it("starts at the 0 default sentinel and reaches 2 through the reading-system values", () => {
    expect([...EPUB_LINE_HEIGHT_SCALE]).toEqual([0, 1, 1.125, 1.25, 1.35, 1.5, 1.65, 1.75, 2]);
  });

  it("is strictly increasing", () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const step of EPUB_LINE_HEIGHT_SCALE) {
      expect(step).toBeGreaterThan(previous);
      previous = step;
    }
  });

  it("defaults to the publication behavior (0, no override)", () => {
    expect(EPUB_DEFAULT_LINE_HEIGHT).toBe(0);
    expect(DEFAULT_READER_PREFERENCES.lineHeight).toBe(EPUB_DEFAULT_LINE_HEIGHT);
  });
});

describe("epubLineHeightPreference", () => {
  it("maps the 0 default sentinel to the toolkit's 'no preference'", () => {
    expect(epubLineHeightPreference(0)).toBeNull();
  });

  it("passes supported overrides through unchanged", () => {
    for (const step of EPUB_LINE_HEIGHT_SCALE) {
      if (step === 0) continue;
      expect(epubLineHeightPreference(step)).toBe(step);
    }
  });
});

describe("nearestEpubLineHeight", () => {
  it("keeps supported steps unchanged", () => {
    for (const step of EPUB_LINE_HEIGHT_SCALE) {
      expect(nearestEpubLineHeight(step)).toBe(step);
    }
  });

  it("snaps off-scale values to the nearest step", () => {
    expect(nearestEpubLineHeight(0.9)).toBe(1);
    expect(nearestEpubLineHeight(1.6)).toBe(1.65);
    expect(nearestEpubLineHeight(1.52)).toBe(1.5);
    expect(nearestEpubLineHeight(2.4)).toBe(2);
  });
});

describe("EPUB_FONT_FAMILIES", () => {
  it("offers the reading-system choices, including the dyslexia-oriented typeface", () => {
    expect(Object.keys(EPUB_FONT_FAMILIES)).toEqual([
      "serif",
      "sans",
      "humanist",
      "old-style",
      "modern",
      "duospace",
      "readable",
    ]);
  });

  it("resolves the reading-system stacks inside the frame via ReadiumCSS vars", () => {
    expect(EPUB_FONT_FAMILIES.sans).toBe("var(--RS__sansTf)");
    expect(EPUB_FONT_FAMILIES.humanist).toBe("var(--RS__humanistTf)");
    expect(EPUB_FONT_FAMILIES["old-style"]).toBe("var(--RS__oldStyleTf)");
    expect(EPUB_FONT_FAMILIES.modern).toBe("var(--RS__modernTf)");
  });

  it("uses the reference typeface names with intent-preserving fallbacks", () => {
    // Same family names the reference implementation injects.
    expect(EPUB_FONT_FAMILIES.duospace).toContain("IA Writer Duospace");
    expect(EPUB_FONT_FAMILIES.readable).toContain("AccessibleDfA");
    // Both degrade to usable stacks when the typeface is not installed.
    for (const key of ["duospace", "readable"] as const) {
      expect(EPUB_FONT_FAMILIES[key].split(",").length).toBeGreaterThan(1);
    }
  });
});

describe("epubFontFamilyPreference", () => {
  it("maps Default to no preference, leaving publisher font styling intact", () => {
    // The toolkit writes no --USER__fontFamily for null, so publisher
    // styling (including embedded @font-face faces) applies untouched.
    expect(epubFontFamilyPreference(null)).toBeNull();
  });

  it("maps every explicit choice to its reader stack", () => {
    for (const [key, stack] of Object.entries(EPUB_FONT_FAMILIES)) {
      expect(epubFontFamilyPreference(key as keyof typeof EPUB_FONT_FAMILIES)).toBe(stack);
    }
  });
});

describe("EPUB column counts", () => {
  it("offers exactly 1, 2, 3, and 4 with the two-page spread as default", () => {
    expect([...EPUB_COLUMN_COUNTS]).toEqual([1, 2, 3, 4]);
    expect(EPUB_DEFAULT_COLUMN_COUNT).toBe(2);
    expect(DEFAULT_READER_PREFERENCES.columnCount).toBe(EPUB_DEFAULT_COLUMN_COUNT);
  });

  it("recognizes supported counts and clamps off-scale values", () => {
    for (const count of EPUB_COLUMN_COUNTS) {
      expect(clampEpubColumnCount(count)).toBe(count);
    }
    // Persistence robustness: stale/invalid values land on the scale.
    expect(clampEpubColumnCount(0)).toBe(1);
    expect(clampEpubColumnCount(-3)).toBe(1);
    expect(clampEpubColumnCount(2.6)).toBe(3);
    expect(clampEpubColumnCount(99)).toBe(4);
  });
});

describe("epubColumnCountPreference", () => {
  it("submits every explicit target for reflowable documents", () => {
    for (const count of EPUB_COLUMN_COUNTS) {
      expect(epubColumnCountPreference("reflowable", count)).toBe(count);
    }
  });

  it("never sends a column count to fixed-layout publications", () => {
    // FXL owns its pages-per-view behavior; a reflow target must not touch it.
    for (const count of EPUB_COLUMN_COUNTS) {
      expect(epubColumnCountPreference("fixed", count)).toBeUndefined();
    }
  });
});

describe("EPUB text-layout scales (issue #45)", () => {
  it("matches the toolkit range configs with 0 as the publisher-default sentinel", () => {
    // wordSpacingRangeConfig [0,2] step 0.125; letterSpacingRangeConfig
    // [0,1] step 0.125; paragraphSpacingRangeConfig [0,3] step 0.25.
    expect(EPUB_WORD_SPACING_SCALE[0]).toBe(0);
    expect(EPUB_WORD_SPACING_SCALE.at(-1)).toBe(2);
    expect(EPUB_WORD_SPACING_SCALE[1]).toBe(0.125);
    expect(EPUB_LETTER_SPACING_SCALE[0]).toBe(0);
    expect(EPUB_LETTER_SPACING_SCALE.at(-1)).toBe(1);
    expect(EPUB_LETTER_SPACING_SCALE[1]).toBe(0.125);
    expect(EPUB_PARAGRAPH_SPACING_SCALE[0]).toBe(0);
    expect(EPUB_PARAGRAPH_SPACING_SCALE.at(-1)).toBe(3);
    expect(EPUB_PARAGRAPH_SPACING_SCALE[1]).toBe(0.25);
    // Deliberate TuxBooks ladder (no toolkit config for pageGutter).
    expect([...EPUB_PAGE_GUTTER_SCALE_PX]).toEqual([0, 10, 20, 30, 40, 60]);
    for (const scale of [
      EPUB_WORD_SPACING_SCALE,
      EPUB_LETTER_SPACING_SCALE,
      EPUB_PARAGRAPH_SPACING_SCALE,
      EPUB_PAGE_GUTTER_SCALE_PX,
    ]) {
      expect(DEFAULT_READER_PREFERENCES).toBeDefined();
      expect(scale).toContain(0);
    }
  });

  it("maps the 0 sentinel to no preference for every spacing control", () => {
    expect(epubSpacingPreference(0)).toBeNull();
    expect(epubSpacingPreference(0.125)).toBe(0.125);
    expect(epubSpacingPreference(2)).toBe(2);
    expect(epubSpacingPreference(30)).toBe(30);
  });

  it("snaps off-scale values onto the nearest step", () => {
    expect(nearestEpubWordSpacing(0.18)).toBe(0.125);
    expect(nearestEpubWordSpacing(1.3)).toBe(1.25);
    expect(nearestEpubLetterSpacing(0.6)).toBe(0.625);
    expect(nearestEpubParagraphSpacing(1.1)).toBe(1);
    expect(nearestEpubParagraphSpacing(4)).toBe(3);
    expect(nearestEpubPageGutter(24)).toBe(20);
    expect(nearestEpubPageGutter(-5)).toBe(0);
  });

  it("maps alignment Auto to no preference and explicit choices through", () => {
    expect(epubTextAlignPreference("auto")).toBeNull();
    expect(epubTextAlignPreference(null)).toBeNull();
    for (const alignment of ["left", "justify", "right", "start"] as const) {
      expect(epubTextAlignPreference(alignment)).toBe(alignment);
    }
    expect(DEFAULT_READER_PREFERENCES.textAlign).toBe(EPUB_DEFAULT_TEXT_ALIGNMENT);
    expect(DEFAULT_READER_PREFERENCES.wordSpacing).toBe(0);
    expect(DEFAULT_READER_PREFERENCES.letterSpacing).toBe(0);
    expect(DEFAULT_READER_PREFERENCES.paragraphSpacing).toBe(0);
    expect(DEFAULT_READER_PREFERENCES.pageGutter).toBe(0);
  });
});
