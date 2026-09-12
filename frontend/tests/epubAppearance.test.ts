import { describe, expect, it } from "vitest";
import { EPUB_BASE_FONT_PX, EPUB_FONT_RATIO_RANGE, epubFontSizeRatio } from "@/lib/epub/appearance";
import { DEFAULT_READER_PREFERENCES } from "@/state/readerState";

/**
 * Font-size unit mapping between the UI (CSS px) and the Readium toolkit
 * (unitless ratio, accepted range [0.7, 4]). A raw px value is outside the
 * accepted range and is silently dropped by the EpubPreferences validation
 * — the regression this pins (issue #40).
 */

/** The appearance slider's bounds (ReaderAppearance.tsx). */
const SLIDER_MIN_PX = 14;
const SLIDER_MAX_PX = 22;

describe("epubFontSizeRatio", () => {
  it("maps the app default to Readium's 1.0 (publication native size)", () => {
    expect(EPUB_BASE_FONT_PX).toBe(DEFAULT_READER_PREFERENCES.fontSize);
    expect(epubFontSizeRatio(DEFAULT_READER_PREFERENCES.fontSize)).toBe(1);
  });

  it("keeps every slider position inside Readium's accepted range", () => {
    for (let px = SLIDER_MIN_PX; px <= SLIDER_MAX_PX; px += 1) {
      const ratio = epubFontSizeRatio(px);
      expect(ratio).toBeGreaterThanOrEqual(EPUB_FONT_RATIO_RANGE[0]);
      expect(ratio).toBeLessThanOrEqual(EPUB_FONT_RATIO_RANGE[1]);
    }
  });

  it("converts monotonically: bigger px never yields a smaller ratio", () => {
    for (let px = SLIDER_MIN_PX + 1; px <= SLIDER_MAX_PX; px += 1) {
      expect(epubFontSizeRatio(px)).toBeGreaterThan(epubFontSizeRatio(px - 1));
    }
  });

  it("rejects the raw px unit the conversion replaces (regression pin)", () => {
    // Every raw slider value would be discarded by EpubPreferences' range
    // validation — exactly the silently-dropped preference of issue #40.
    for (let px = SLIDER_MIN_PX; px <= SLIDER_MAX_PX; px += 1) {
      expect(px).toBeGreaterThan(EPUB_FONT_RATIO_RANGE[1]);
    }
  });
});
