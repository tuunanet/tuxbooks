import { describe, expect, it } from "vitest";
import {
  isPdfThemeChoice,
  pdfThemeTreatment,
  PDF_THEME_CHOICES,
  PDF_THEME_TREATMENTS,
} from "@/lib/pdf/theme";
import { EPUB_THEME_COLORS } from "@/lib/epub/appearance";

describe("PDF theme treatments", () => {
  it("leaves the neutral and light pages untreated", () => {
    expect(pdfThemeTreatment("default")).toEqual({});
    expect(pdfThemeTreatment("light")).toEqual({});
  });

  it("maps the dark theme to the fixed-content invert recipe", () => {
    // Foliate's recipe for fixed content in dark mode.
    expect(pdfThemeTreatment("dark").filter).toBe("invert(1) hue-rotate(180deg)");
    expect(pdfThemeTreatment("dark").tint).toBeUndefined();
  });

  it("tints paper pages with the theme's own paper color", () => {
    // A filter cannot darken white (the sepia matrix clamps white to
    // near-white); the multiply tint turns white pages exactly into the
    // theme's paper background, shared with the EPUB palette.
    expect(pdfThemeTreatment("paper").filter).toBeUndefined();
    expect(pdfThemeTreatment("paper").tint).toBe(EPUB_THEME_COLORS.paper.background);
  });

  it("has a treatment for exactly the themes offered to PDFs", () => {
    // Default/Light render as-is; the dark presets filter.
    for (const theme of PDF_THEME_CHOICES) {
      expect(theme in PDF_THEME_TREATMENTS).toBe(true);
      expect(isPdfThemeChoice(theme)).toBe(true);
    }
    expect(pdfThemeTreatment("contrast").filter).toBeTruthy();
    // The recolor-only presets have no faithful treatment for a raster
    // page, so they are EPUB-only.
    expect(isPdfThemeChoice("blue-contrast")).toBe(false);
    expect(isPdfThemeChoice("mint-contrast")).toBe(false);
    expect(pdfThemeTreatment("blue-contrast")).toEqual({});
    expect(pdfThemeTreatment("mint-contrast")).toEqual({});
    // Every theme key is still mapped (total map over the theme set).
    expect(Object.keys(PDF_THEME_TREATMENTS).length).toBe(
      Object.keys(EPUB_THEME_COLORS).length + 1,
    );
  });
});
