/**
 * PDF theme support (issue #46 follow-up): a PDF page is a fixed-layout
 * raster, so the only theme mechanism is a treatment over the rendered
 * surface. Two mechanisms exist, because CSS filters cannot darken a white
 * page (the sepia matrix clamps white to near-white):
 *
 * - `filter` — per-pixel transforms for the dark presets. Dark uses the
 *   fixed-content invert recipe Foliate surfaces as "Invert Colors in Dark
 *   Mode"; High contrast combines grayscale + invert + a contrast boost.
 * - `tint` — a multiply-blend color laid over the pages, used for Paper:
 *   white × tint = the tint (exactly the theme's paper background, shared
 *   with the EPUB palette), black stays black, and other colors pick up
 *   the warm cast like real paper under light.
 *
 * Blue and Mint have no faithful treatment (they rely on text/background
 * recoloring), so they are not offered for PDFs and map to no-ops.
 * Thorium ships no PDF theming at all; this keeps the useful half.
 */
import { EPUB_THEME_COLORS, type EpubThemeName } from "@/lib/epub/appearance";

export interface PdfThemeTreatment {
  filter?: string;
  tint?: string;
}

export const PDF_THEME_TREATMENTS: Record<EpubThemeName, PdfThemeTreatment> = {
  default: {},
  light: {},
  paper: { tint: EPUB_THEME_COLORS.paper.background },
  dark: { filter: "invert(1) hue-rotate(180deg)" },
  contrast: { filter: "grayscale(1) invert(1) contrast(1.4)" },
  "blue-contrast": {},
  "mint-contrast": {},
};

/** Treatment for a theme; empty object when the pages render as-is. */
export function pdfThemeTreatment(theme: EpubThemeName): PdfThemeTreatment {
  return PDF_THEME_TREATMENTS[theme];
}

/**
 * Surface color for PDF chrome that floats over the pages (the sticky
 * toolbar): the theme's own background while a treatment is active, so no
 * unthemed app-white strip floats over tinted/inverted pages; undefined
 * keeps the translucent app chrome for the neutral themes.
 */
export function pdfToolbarSurface(theme: EpubThemeName): string | undefined {
  const treatment = PDF_THEME_TREATMENTS[theme];
  if (!treatment.filter && !treatment.tint) return undefined;
  return theme === "default" ? undefined : EPUB_THEME_COLORS[theme].background;
}

/** Themes offered for PDFs: only those with a faithful treatment. */
export const PDF_THEME_CHOICES = ["default", "light", "paper", "dark", "contrast"] as const;

export function isPdfThemeChoice(theme: EpubThemeName): boolean {
  return (PDF_THEME_CHOICES as readonly string[]).includes(theme);
}
