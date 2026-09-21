/**
 * PDF dark colour scheme (ADR 0002). The reader's palette (`SmartPalette`,
 * derived from the EPUB dark preset) maps onto PDFium's category-level
 * `FPDF_COLORSCHEME`: path fill and stroke, text fill and stroke, as 32-bit
 * `0xAARRGGBB` values. Images are not a category, so photographs and scanned
 * rasters keep their pixels. This is the coarse successor to object-level
 * recoloring.
 *
 * Everything here is pure math over 0–1 component arrays: no engine, no DOM,
 * unit-testable without the WASM build.
 */

/** RGB triplet in 0–1 components. */
export type Rgb = [number, number, number];

/** The dark palette the reader maps onto the engine's colour scheme. */
export interface SmartPalette {
  /** What white/near-white content maps to (the dark page background). */
  background: Rgb;
  /** What black/near-black content maps to (light text). */
  text: Rgb;
}

/**
 * PDFium's `FPDF_COLORSCHEME` recolors page content by category: path fill
 * and stroke, text fill and stroke, as 32-bit `0xAARRGGBB` values. Images are
 * not a category, so photographs and scanned rasters keep their pixels.
 */
export interface FpdfColorScheme {
  pathFill: number;
  pathStroke: number;
  textFill: number;
  textStroke: number;
}

/**
 * The `FPDF_CONVERT_FILL_TO_STROKE` render flag (PDFium `fpdfview.h`): stroke
 * every path fill with the scheme's path stroke colour. A single fill colour
 * for all paths makes adjacent fills merge into the page background, so this
 * light edge keeps their boundaries legible.
 */
export const FPDF_CONVERT_FILL_TO_STROKE = 0x20;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** One 0–1 RGB component as an 8-bit channel. */
function channel(value: number): number {
  return Math.round(clamp01(value) * 255);
}

/** RGB 0–1 → PDFium's 32-bit `0xAARRGGBB`. */
export function rgbToArgb(rgb: Rgb): number {
  return ((0xff << 24) | (channel(rgb[0]) << 16) | (channel(rgb[1]) << 8) | channel(rgb[2])) >>> 0;
}

/**
 * Map a palette onto PDFium's category colour scheme. The document's path
 * fills take the page background and its text takes the light text colour;
 * the cross terms (path stroke, text stroke) are the opposite endpoint, so a
 * stroke or a fill converted to a stroke stays visible against its fill. A
 * coloured vector fill loses its hue (path fills all share one colour), which
 * is the accepted degradation.
 */
export function colorSchemeFromPalette(palette: SmartPalette): FpdfColorScheme {
  const background = rgbToArgb(palette.background);
  const text = rgbToArgb(palette.text);
  return { pathFill: background, pathStroke: text, textFill: text, textStroke: background };
}

/** Parse a `#rrggbb` color into 0–1 RGB; null when the string is not that form. */
export function hexToRgb01(hex: string): Rgb | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}
