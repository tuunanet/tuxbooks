/**
 * PDF theme support (issue #46 follow-up): a PDF page is a fixed-layout
 * raster, so the only theme mechanism is a CSS filter over the rendered
 * surface — the same approach Foliate uses for fixed content in dark mode
 * (`invert(1) hue-rotate(180deg)`, user-facing as "Invert Colors in Dark
 * Mode"). Thorium instead ships no PDF theming at all. The reflow color
 * preferences are meaningless here and are never submitted for PDFs.
 *
 * Blue and Mint have no faithful filter (they rely on text/background
 * recoloring), so they are not offered for PDFs and map to no filter.
 */
import type { EpubThemeName } from "@/lib/epub/appearance";

export const PDF_THEME_FILTERS: Record<EpubThemeName, string | undefined> = {
  default: undefined,
  light: undefined,
  paper: "sepia(0.25)",
  dark: "invert(1) hue-rotate(180deg)",
  contrast: "grayscale(1) invert(1) contrast(1.4)",
  "blue-contrast": undefined,
  "mint-contrast": undefined,
};

/** Filter for a theme, or undefined when the theme leaves the pages as-is. */
export function pdfThemeFilter(theme: EpubThemeName): string | undefined {
  return PDF_THEME_FILTERS[theme];
}

/** Themes offered for PDFs: only those with a faithful filter mapping. */
export const PDF_THEME_CHOICES = ["default", "light", "paper", "dark", "contrast"] as const;

export function isPdfThemeChoice(theme: EpubThemeName): boolean {
  return (PDF_THEME_CHOICES as readonly string[]).includes(theme);
}
