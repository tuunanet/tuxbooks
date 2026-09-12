import { describe, expect, it } from "vitest";
import {
  isPdfThemeChoice,
  pdfThemeFilter,
  PDF_THEME_CHOICES,
  PDF_THEME_FILTERS,
} from "@/lib/pdf/theme";
import { EPUB_THEME_COLORS } from "@/lib/epub/appearance";

describe("PDF theme filters", () => {
  it("leaves the neutral and light pages unfiltered", () => {
    expect(pdfThemeFilter("default")).toBeUndefined();
    expect(pdfThemeFilter("light")).toBeUndefined();
  });

  it("maps the dark theme to the fixed-content invert recipe", () => {
    // Foliate's recipe for fixed content in dark mode.
    expect(pdfThemeFilter("dark")).toBe("invert(1) hue-rotate(180deg)");
  });

  it("has a faithful handling for exactly the themes offered to PDFs", () => {
    // Default/Light render as-is; the dark presets filter.
    for (const theme of PDF_THEME_CHOICES) {
      expect(theme in PDF_THEME_FILTERS).toBe(true);
      expect(isPdfThemeChoice(theme)).toBe(true);
    }
    expect(pdfThemeFilter("dark")).toBeTruthy();
    expect(pdfThemeFilter("contrast")).toBeTruthy();
    // The recolor-only presets have no faithful filter for a raster page,
    // so they are EPUB-only.
    expect(isPdfThemeChoice("blue-contrast")).toBe(false);
    expect(isPdfThemeChoice("mint-contrast")).toBe(false);
    expect(pdfThemeFilter("blue-contrast")).toBeUndefined();
    expect(pdfThemeFilter("mint-contrast")).toBeUndefined();
    // Every non-EPUB-offered theme key is still mapped (total map).
    expect(Object.keys(PDF_THEME_FILTERS).length).toBe(Object.keys(EPUB_THEME_COLORS).length + 1);
  });
});
