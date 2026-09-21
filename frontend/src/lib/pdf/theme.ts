/**
 * PDF theme support (issue #46, extended by issue #67): a PDF page is a
 * fixed-layout raster, so the theme reaches it through three mechanisms:
 *
 * - `filter` — per-pixel CSS transforms over the rendered surface. Invert
 *   uses the fixed-content invert recipe Foliate surfaces as "Invert Colors
 *   in Dark Mode" (the old Dark behavior — an explicit negative for users
 *   who want it); High contrast combines grayscale + invert + a contrast
 *   boost.
 * - `tint` — a multiply-blend color laid over the pages, used for Paper:
 *   white × tint = the tint (exactly the theme's own paper color, shared
 *   with the EPUB palette), black stays black, and other colors pick up
 *   the warm cast like real paper under light.
 * - `smart` — category-level recoloring inside the PDFium worker *before*
 *   rasterization (ADR 0002): path fills and strokes and text fills and
 *   strokes are remapped from the document's palette onto the dark one
 *   through `FPDF_COLORSCHEME`, while images keep their pixels so
 *   photographs, covers, and screenshots stay recognizable (a CSS filter
 *   only sees finished pixels). The Dark theme uses this color scheme — the
 *   normal dark-mode behavior; see lib/pdf/smartColors.ts for the mapping.
 *
 * Blue and Mint have no faithful treatment (they rely on text/background
 * recoloring), so they are not offered for PDFs and map to no-ops.
 * Thorium ships no PDF theming at all; this keeps the useful half.
 */
import { EPUB_THEME_COLORS, type ReaderTheme } from "@/lib/epub/appearance";
import { hexToRgb01, type SmartPalette } from "./smartColors";

export interface PdfThemeTreatment {
  filter?: string;
  tint?: string;
  /** Worker-side dark colour-scheme palette (PDFium categories). */
  smart?: SmartPalette;
  /**
   * CSS background for the page slots while their raster is pending
   * (issue #67 follow-up): a PDF page paints no background of its own —
   * in Original mode the viewer's white shows through, but a Smart Dark
   * page that is still queued/rendering must not flash white before its
   * dark bitmap blits. The color is the same preset the worker pre-fills
   * the raster with, so placeholder and rendered pixels agree exactly.
   * Filter-based dark modes need none (the filter inverts the white
   * placeholder live).
   */
  pageBackground?: string;
}

/**
 * The dark colour scheme's palette is the reader's own dark preset: the
 * shell chrome and the recolored pages share one background/text pair, so
 * the document surface and the reader around it never disagree.
 */
const SMART_DARK_PALETTE: SmartPalette = {
  background: hexToRgb01(EPUB_THEME_COLORS.dark.background) ?? [0.063, 0.063, 0.075],
  text: hexToRgb01(EPUB_THEME_COLORS.dark.text) ?? [0.894, 0.894, 0.906],
};

export const PDF_THEME_TREATMENTS: Record<ReaderTheme, PdfThemeTreatment> = {
  default: {},
  light: {},
  paper: { tint: EPUB_THEME_COLORS.paper.background },
  dark: { smart: SMART_DARK_PALETTE, pageBackground: EPUB_THEME_COLORS.dark.background },
  // The explicit negative-style mode (issue #67): the old Dark recipe,
  // kept for users who actually want a full-page inversion.
  invert: { filter: "invert(1) hue-rotate(180deg)" },
  contrast: { filter: "grayscale(1) invert(1) contrast(1.4)" },
  "blue-contrast": {},
  "mint-contrast": {},
};

/** Treatment for a theme; empty object when the pages render as-is. */
export function pdfThemeTreatment(theme: ReaderTheme): PdfThemeTreatment {
  return PDF_THEME_TREATMENTS[theme];
}

/** Themes offered for PDFs: only those with a faithful treatment. */
export const PDF_THEME_CHOICES = [
  "default",
  "light",
  "paper",
  "dark",
  "contrast",
  "invert",
] as const;

/**
 * The appearance menu's PDF theme choices (issue #67), in presentation
 * order. The dark preset reads "Smart dark" because its behavior differs
 * from the EPUB preset of the same name — category colour-scheme recoloring
 * in the worker instead of a CSS filter — while remaining the same stored
 * theme;
 * Invert is the explicit negative kept for users who want it.
 */
export const PDF_THEME_MENU_OPTIONS: { value: ReaderTheme; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "light", label: "Light" },
  { value: "paper", label: "Paper" },
  { value: "dark", label: "Smart dark" },
  { value: "invert", label: "Invert" },
  { value: "contrast", label: "High contrast" },
];

export function isPdfThemeChoice(theme: ReaderTheme): boolean {
  return (PDF_THEME_CHOICES as readonly string[]).includes(theme);
}
