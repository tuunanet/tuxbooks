import { describe, expect, it } from "vitest";
import {
  isPdfThemeChoice,
  pdfThemeTreatment,
  PDF_THEME_CHOICES,
  PDF_THEME_MENU_OPTIONS,
  PDF_THEME_TREATMENTS,
} from "@/lib/pdf/theme";
import { EPUB_THEME_COLORS } from "@/lib/epub/appearance";
import { hexToRgb01 } from "@/lib/pdf/smartColors";

describe("PDF theme treatments", () => {
  it("leaves the neutral and light pages untreated", () => {
    expect(pdfThemeTreatment("default")).toEqual({});
    expect(pdfThemeTreatment("light")).toEqual({});
  });

  it("maps the dark theme to the worker colour scheme (ADR 0002)", () => {
    // Dark is no longer a CSS invert filter: pages rasterize with the
    // category-level recoloring palette shared with the EPUB dark preset.
    const treatment = pdfThemeTreatment("dark");
    expect(treatment.filter).toBeUndefined();
    expect(treatment.tint).toBeUndefined();
    expect(treatment.smart).toEqual({
      background: hexToRgb01(EPUB_THEME_COLORS.dark.background),
      text: hexToRgb01(EPUB_THEME_COLORS.dark.text),
    });
    // The palette is a genuinely dark/light pair.
    expect(treatment.smart?.background.reduce((a, b) => a + b, 0)).toBeLessThan(0.5);
    expect(treatment.smart?.text.reduce((a, b) => a + b, 0)).toBeGreaterThan(1.5);
    // The pending-page placeholder matches the raster's own pre-fill, so a
    // queued/rendering page never flashes white on a dark surface.
    expect(treatment.pageBackground).toBe(EPUB_THEME_COLORS.dark.background);
  });

  it("needs no placeholder for the filter-based and as-is treatments", () => {
    // Filter modes invert the white placeholder live; as-is modes are
    // faithful white pages.
    expect(pdfThemeTreatment("invert").pageBackground).toBeUndefined();
    expect(pdfThemeTreatment("contrast").pageBackground).toBeUndefined();
    expect(pdfThemeTreatment("default").pageBackground).toBeUndefined();
    expect(pdfThemeTreatment("light").pageBackground).toBeUndefined();
  });

  it("keeps the explicit negative as the Invert choice (issue #67)", () => {
    // The old Dark recipe survives as a first-class mode for users who
    // actually want a full-page inversion.
    expect(pdfThemeTreatment("invert").filter).toBe("invert(1) hue-rotate(180deg)");
    expect(pdfThemeTreatment("invert").tint).toBeUndefined();
    expect(pdfThemeTreatment("invert").smart).toBeUndefined();
  });

  it("tints paper pages with the theme's own paper color", () => {
    // A filter cannot darken white (the sepia matrix clamps white to
    // near-white); the multiply tint turns white pages exactly into the
    // theme's paper background, shared with the EPUB palette.
    expect(pdfThemeTreatment("paper").filter).toBeUndefined();
    expect(pdfThemeTreatment("paper").tint).toBe(EPUB_THEME_COLORS.paper.background);
  });

  it("has a treatment for exactly the themes offered to PDFs", () => {
    // Default/Light render as-is; Dark recolors in the worker; Invert and
    // High contrast filter.
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
    // Every theme key is still mapped (total map over the theme set: the
    // EPUB palette names + the neutral default + the PDF-only Invert).
    expect(Object.keys(PDF_THEME_TREATMENTS).length).toBe(
      Object.keys(EPUB_THEME_COLORS).length + 2,
    );
  });

  it("offers the menu choices with Invert and the Smart dark label", () => {
    const values = PDF_THEME_MENU_OPTIONS.map((option) => option.value);
    expect(values).toContain("dark");
    expect(values).toContain("invert");
    expect(values).not.toContain("blue-contrast");
    expect(values.every((value) => isPdfThemeChoice(value))).toBe(true);
    const labels = PDF_THEME_MENU_OPTIONS.map((option) => option.label);
    expect(labels).toContain("Smart dark");
    expect(labels).toContain("Invert");
  });
});
