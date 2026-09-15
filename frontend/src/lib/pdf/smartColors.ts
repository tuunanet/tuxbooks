/**
 * Smart Dark color math (issue #67): object-aware recoloring performed
 * inside the MuPDF worker before rasterization. Text, vector fills, strokes,
 * and image-mask paints are remapped from the document's own palette onto
 * the dark reading palette (dark page background, light text), while
 * ordinary raster images pass through unchanged so photographs, covers, and
 * screenshots keep their colors instead of turning into negatives.
 *
 * The mapping follows the principle Sioyek's custom-color mode established
 * (map black→text color, white→background color, linearly) with one
 * refinement: chromatic colors must not flip hue. A pure per-channel lerp
 * maps a blue link onto an orange-ish gray, so saturated colors instead keep
 * their hue and only have their lightness pulled toward the middle of the
 * dark palette's usable range. The blend between the two behaviors is
 * weighted by the color's chroma, so gray ramps (text, hairlines, page
 * backgrounds) flip exactly while saturated accents stay recognizable.
 *
 * Everything here is pure math over 0–1 component arrays: no MuPDF, no DOM,
 * unit-testable without the engine.
 */

/** RGB triplet in 0–1 components. */
export type Rgb = [number, number, number];

/** The dark palette Smart Dark remaps the document's own colors onto. */
export interface SmartPalette {
  /** What white/near-white content maps to (the dark page background). */
  background: Rgb;
  /** What black/near-black content maps to (light text). */
  text: Rgb;
}

/**
 * Chroma at or above this weight counts as fully chromatic. Grays (text,
 * hairlines, page fills) sit far below; saturated accents above.
 */
const CHROMA_GATE = 0.15;

/**
 * Lightness compression for chromatic colors: how strongly a saturated
 * color's HSL lightness is pulled toward the middle (0 = keep original
 * lightness, 1 = clamp everything to mid-gray lightness). A dark navy
 * background block stays dark-ish, a bright yellow highlight stays
 * light-ish, both remain usable on the dark page.
 */
const LIGHTNESS_COMPRESSION = 0.4;

/** Rec. 709 luminance of an RGB triplet (0–1 components). */
export function luminance(rgb: Rgb): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** Channel spread (max − min), a saturation proxy in 0–1. */
export function chroma(rgb: Rgb): number {
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    return [l, l, l];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (offset: number): number => {
    let t = offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

function rgbToHsl(rgb: Rgb): [number, number, number] {
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rgb[0]) {
    h = (rgb[1] - rgb[2]) / d + (rgb[1] < rgb[2] ? 6 : 0);
  } else if (max === rgb[1]) {
    h = (rgb[2] - rgb[0]) / d + 2;
  } else {
    h = (rgb[0] - rgb[1]) / d + 4;
  }
  return [h / 6, s, l];
}

/** The palette's own lightness extent on the HSL axis, for chromatic remaps. */
function paletteLightness(palette: SmartPalette): { dark: number; light: number } {
  return {
    dark: rgbToHsl(palette.background)[2],
    light: rgbToHsl(palette.text)[2],
  };
}

/**
 * Recolor one RGB color onto the dark palette.
 *
 * - Black → the palette text color, white → the palette background, grays
 *   ramp linearly between them (luminance-controlled).
 * - Chromatic colors keep their hue and only have their lightness
 *   compressed toward the middle of the dark range, so links, underlines,
 *   and accent fills stay recognizable; the chroma weight blends smoothly
 *   between the two behaviors.
 * - Alpha is the caller's concern: the fill alpha passes through unchanged.
 */
export function recolorColor(color: Rgb, palette: SmartPalette): Rgb {
  const t = 1 - clamp01(luminance(color));
  const achromatic: Rgb = [
    lerp(palette.background[0], palette.text[0], t),
    lerp(palette.background[1], palette.text[1], t),
    lerp(palette.background[2], palette.text[2], t),
  ];
  const spread = chroma(color);
  if (spread <= 0.02) {
    return achromatic;
  }
  const weight = clamp01(spread / CHROMA_GATE);
  if (weight >= 1) {
    const [h, s, l] = rgbToHsl(color);
    const extent = paletteLightness(palette);
    return hslToRgb(h, s, lerp(extent.dark, extent.light, lerp(0.5, l, LIGHTNESS_COMPRESSION)));
  }
  const [h, s, l] = rgbToHsl(color);
  const extent = paletteLightness(palette);
  const chromatic = hslToRgb(
    h,
    s,
    lerp(extent.dark, extent.light, lerp(0.5, l, LIGHTNESS_COMPRESSION)),
  );
  return [
    lerp(achromatic[0], chromatic[0], weight),
    lerp(achromatic[1], chromatic[1], weight),
    lerp(achromatic[2], chromatic[2], weight),
  ];
}

/** Parse a `#rrggbb` color into 0–1 RGB; null when the string is not that form. */
export function hexToRgb01(hex: string): Rgb | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/**
 * Device color → RGB for recoloring. `color` carries `components` values in
 * the device colorspace named by `type`. Known colorspaces convert (Gray
 * replicates, CMYK converts subtractively, BGR swaps); unknown types return
 * null and the caller forwards the operation unchanged rather than guessing.
 */
export function deviceColorToRgb(color: number[], type: string, components: number): Rgb | null {
  if (type === "Gray" && components === 1 && color.length >= 1) {
    const gray = color[0] ?? 0;
    return [gray, gray, gray];
  }
  if ((type === "RGB" || type === "Lab") && components >= 3 && color.length >= 3) {
    // Lab components are not RGB channels, but a Lab fill whose L* is what
    // matters maps acceptably through the triple treated as RGB; real Lab
    // text colors are rare and the palette remap dominates the result.
    return [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0];
  }
  if (type === "BGR" && components >= 3 && color.length >= 3) {
    return [color[2] ?? 0, color[1] ?? 0, color[0] ?? 0];
  }
  if (type === "CMYK" && components === 4 && color.length >= 4) {
    const cyan = color[0] ?? 0;
    const magenta = color[1] ?? 0;
    const yellow = color[2] ?? 0;
    const black = color[3] ?? 0;
    return [(1 - cyan) * (1 - black), (1 - magenta) * (1 - black), (1 - yellow) * (1 - black)];
  }
  return null;
}

/** Statistics sampled from a raster image, all normalized to 0–1. */
export interface ImageStats {
  /** Fraction of sampled pixels that are near-white (the page-paper signal). */
  nearWhiteFrac: number;
  /** Mean channel spread (saturation proxy). */
  meanSaturation: number;
  /**
   * Fraction of clearly chromatic pixels (channel spread above the
   * COLORED_FRACTION pixel gate). Scanned text pages are overwhelmingly
   * achromatic; designed artwork (covers, diagrams) always carries chromatic
   * accents. Unlike the mean, this is not diluted by a dominant white or
   * black background.
   */
  coloredFrac: number;
  /** Mean luminance. */
  meanLuminance: number;
  /** Luminance variance (text-like contrast signal). */
  luminanceVariance: number;
}

/** Per-pixel sample: components are 0–1 RGB, or null for a skipped sample. */
export type PixelSampler = () => { rgb: Rgb; alpha: number } | null;

/**
 * Sample a pixel buffer for classification statistics. The caller decides
 * the stride (full scan or subsample); this function only accumulates.
 * Transparent samples are ignored (they carry no color).
 */
export function imageStatsFromSampler(sample: PixelSampler, samples: number): ImageStats {
  let nearWhite = 0;
  let saturation = 0;
  let colored = 0;
  let luminanceSum = 0;
  let luminanceSqSum = 0;
  let counted = 0;
  for (let index = 0; index < samples; index += 1) {
    const pixel = sample();
    if (!pixel || pixel.alpha <= 0) {
      continue;
    }
    counted += 1;
    const spread = chroma(pixel.rgb);
    const lum = luminance(pixel.rgb);
    if (spread < 0.06 && lum >= 0.92) {
      nearWhite += 1;
    }
    if (spread > COLORED_PIXEL_CHROMA) {
      colored += 1;
    }
    saturation += spread;
    luminanceSum += lum;
    luminanceSqSum += lum * lum;
  }
  if (counted === 0) {
    return {
      nearWhiteFrac: 0,
      meanSaturation: 0,
      coloredFrac: 0,
      meanLuminance: 1,
      luminanceVariance: 0,
    };
  }
  const meanLum = luminanceSum / counted;
  return {
    nearWhiteFrac: nearWhite / counted,
    meanSaturation: saturation / counted,
    coloredFrac: colored / counted,
    meanLuminance: meanLum,
    luminanceVariance: Math.max(0, luminanceSqSum / counted - meanLum * meanLum),
  };
}

/**
 * Classification of one raster image draw inside a Smart Dark page:
 * `preserve` keeps the original colors (photographs, illustrations, covers,
 * screenshots), `recolor` remaps the image onto the dark palette the same
 * way vector content is remapped (scanned/rasterized text pages).
 */
export type RasterImageTreatment = "preserve" | "recolor";

/**
 * Minimum fraction of the page an image must cover to be considered a page
 * background at all; anything smaller is an illustration or diagram and is
 * always preserved.
 */
export const PAGE_IMAGE_COVERAGE_THRESHOLD = 0.6;

/**
 * Near-white fraction above which a page-covering image reads as
 * paper-backed (a scan or a rasterized document page) rather than a photo
 * or cover. Photos rarely carry more than half their pixels near white.
 */
export const NEAR_WHITE_THRESHOLD = 0.5;

/** Mean saturation above which the image is colorful enough to preserve. */
export const MEAN_SATURATION_THRESHOLD = 0.35;

/**
 * Channel spread at or above which a pixel counts as clearly chromatic
 * (the COLORED_FRACTION signal's per-pixel gate).
 */
export const COLORED_PIXEL_CHROMA = 0.2;

/**
 * Fraction of clearly chromatic pixels above which a paper-backed image is
 * treated as designed artwork rather than a scan (issue #67 follow-up):
 * covers and diagrams carry chromatic accents — a red logo, colored
 * eyes/fur, a mossy branch — while scanned text is overwhelmingly
 * achromatic. The mean saturation cannot make this call: on a
 * white-dominant page (the AI Engineering cover measures 2.7% chromatic
 * pixels at a mean spread of just 0.027) the mean is diluted into
 * indistinguishability. JPEG chroma noise on B/W scans stays far below
 * this gate.
 */
export const COLORED_FRACTION_THRESHOLD = 0.02;

/**
 * Decide the treatment of a page-covering image from its statistics. A
 * paper-backed, achromatic image is treated like the document's own content
 * (recolor — the scan/rasterized-page case); anything with meaningful
 * chromatic content keeps its colors (covers, photos, diagrams).
 */
export function classifyRasterImage(stats: ImageStats, coverage: number): RasterImageTreatment {
  if (coverage < PAGE_IMAGE_COVERAGE_THRESHOLD) {
    return "preserve";
  }
  if (
    stats.nearWhiteFrac >= NEAR_WHITE_THRESHOLD &&
    stats.meanSaturation <= MEAN_SATURATION_THRESHOLD &&
    stats.coloredFrac < COLORED_FRACTION_THRESHOLD
  ) {
    return "recolor";
  }
  return "preserve";
}

/**
 * Recolor a pixel buffer in place onto the palette — the raster equivalent
 * of `recolorColor`, used for classified scans/rasterized pages. The buffer
 * is a tightly packed byte array (0–255); `components` is 3 (RGB) or 4
 * (RGBA, alpha preserved) and `stride` is the row pitch in bytes, so padded
 * pixmaps are walked correctly. Achromatic pixels (scan paper and ink — the
 * overwhelming majority of a scan) take the fast luminance ramp; chromatic
 * pixels keep their hue through the same compressed-lightness remap the
 * vector mapping uses.
 */
export function recolorPixelsInPlace(
  pixels: Uint8ClampedArray,
  components: number,
  stride: number,
  rowCount: number,
  palette: SmartPalette,
): void {
  const extent = paletteLightness(palette);
  for (let row = 0; row < rowCount; row += 1) {
    const rowStart = row * stride;
    for (let offset = rowStart; offset + components <= rowStart + stride; offset += components) {
      const r = (pixels[offset] ?? 0) / 255;
      const g = (pixels[offset + 1] ?? 0) / 255;
      const b = (pixels[offset + 2] ?? 0) / 255;
      const t = 1 - clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
      if (Math.max(r, g, b) - Math.min(r, g, b) <= CHROMA_GATE) {
        pixels[offset] = lerpByte(palette.background[0], palette.text[0], t);
        pixels[offset + 1] = lerpByte(palette.background[1], palette.text[1], t);
        pixels[offset + 2] = lerpByte(palette.background[2], palette.text[2], t);
        continue;
      }
      const [h, s, l] = rgbToHsl([r, g, b]);
      const mapped = hslToRgb(
        h,
        s,
        lerp(extent.dark, extent.light, lerp(0.5, l, LIGHTNESS_COMPRESSION)),
      );
      pixels[offset] = mapped[0] * 255;
      pixels[offset + 1] = mapped[1] * 255;
      pixels[offset + 2] = mapped[2] * 255;
    }
  }
}

function lerpByte(background: number, text: number, t: number): number {
  return clamp01(background + (text - background) * t) * 255;
}
