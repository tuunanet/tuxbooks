import { describe, expect, it } from "vitest";
import {
  classifyRasterImage,
  deviceColorToRgb,
  hexToRgb01,
  imageStatsFromSampler,
  luminance,
  recolorColor,
  recolorPixelsInPlace,
  NEAR_WHITE_THRESHOLD,
  PAGE_IMAGE_COVERAGE_THRESHOLD,
  type ImageStats,
  type SmartPalette,
} from "@/lib/pdf/smartColors";

/** The palette theme.ts derives from the EPUB dark preset. */
const PALETTE: SmartPalette = {
  background: hexToRgb01("#101013") as [number, number, number],
  text: hexToRgb01("#e4e4e7") as [number, number, number],
};

describe("recolorColor", () => {
  it("maps black exactly onto the palette text color", () => {
    expect(recolorColor([0, 0, 0], PALETTE)).toEqual(PALETTE.text);
  });

  it("maps white exactly onto the palette background", () => {
    expect(recolorColor([1, 1, 1], PALETTE)).toEqual(PALETTE.background);
  });

  it("ramps grays linearly between the palette endpoints", () => {
    // Mid-gray is equidistant from both endpoints (per luminance), so it
    // must land on the midpoint of the palette ramp.
    const mapped = recolorColor([0.5, 0.5, 0.5], PALETTE);
    const [bg0, bg1, bg2] = PALETTE.background;
    const [tx0, tx1, tx2] = PALETTE.text;
    const t = 1 - luminance([0.5, 0.5, 0.5]);
    expect(mapped[0]).toBeCloseTo(bg0 + (tx0 - bg0) * t, 5);
    expect(mapped[1]).toBeCloseTo(bg1 + (tx1 - bg1) * t, 5);
    expect(mapped[2]).toBeCloseTo(bg2 + (tx2 - bg2) * t, 5);
  });

  it("keeps dark text dark-flipped to a light, readable color", () => {
    // Near-black text (#1a1a1a) must land near the light text color, not in
    // the middle of the ramp.
    const mapped = recolorColor([0.1, 0.1, 0.1], PALETTE);
    expect(luminance(mapped)).toBeGreaterThan(0.6);
  });

  it("preserves the hue of saturated accents (a blue link stays blue)", () => {
    // A pure per-channel lerp would map #0b62c4 onto an orange-ish gray;
    // the chroma-preserving remap must keep blue the dominant channel.
    const link = [0.043, 0.384, 0.769] as [number, number, number];
    const mapped = recolorColor(link, PALETTE);
    expect(mapped[2]).toBeGreaterThan(mapped[0]); // blue > red
    expect(mapped[2]).toBeGreaterThan(mapped[1]); // blue > green
    // ... and stays readable (not near-black) on the dark page.
    expect(luminance(mapped)).toBeGreaterThan(luminance(link));
  });

  it("keeps pure red recognizable", () => {
    const mapped = recolorColor([1, 0, 0], PALETTE);
    expect(mapped[0]).toBeGreaterThan(0.4);
    expect(mapped[1]).toBeLessThan(0.3);
    expect(mapped[2]).toBeLessThan(0.3);
  });

  it("keeps a dark navy box dark instead of flipping it to light", () => {
    // Saturated dark fills must not flip to the light text ramp the way
    // achromatic darks do — white text on them would become unreadable.
    const mapped = recolorColor([0, 0.165, 0.4], PALETTE);
    expect(luminance(mapped)).toBeLessThan(0.3);
  });

  it("treats near-neutral colors as achromatic", () => {
    // Our own light gray (the theme text color) as a fill must land on the
    // dark side, not pick up spurious chroma handling.
    const mapped = recolorColor([0.894, 0.894, 0.906], PALETTE);
    expect(luminance(mapped)).toBeLessThan(0.2);
  });
});

describe("deviceColorToRgb", () => {
  it("replicates gray", () => {
    expect(deviceColorToRgb([0.25], "Gray", 1)).toEqual([0.25, 0.25, 0.25]);
  });

  it("passes RGB through and swaps BGR", () => {
    expect(deviceColorToRgb([0.1, 0.2, 0.3], "RGB", 3)).toEqual([0.1, 0.2, 0.3]);
    expect(deviceColorToRgb([0.1, 0.2, 0.3], "BGR", 3)).toEqual([0.3, 0.2, 0.1]);
  });

  it("converts CMYK subtractively", () => {
    // Pure black K=1 → black; white (0,0,0,0) → white.
    expect(deviceColorToRgb([0, 0, 0, 1], "CMYK", 4)).toEqual([0, 0, 0]);
    expect(deviceColorToRgb([0, 0, 0, 0], "CMYK", 4)).toEqual([1, 1, 1]);
  });

  it("returns null for unknown colorspaces instead of guessing", () => {
    expect(deviceColorToRgb([2, 128], "Indexed", 1)).toBeNull();
    expect(deviceColorToRgb([0.1, 0.2], "Separation", 2)).toBeNull();
  });
});

describe("imageStatsFromSampler", () => {
  it("recognizes a paper-like sample (white background, dark ink)", () => {
    const samples = 100;
    let index = 0;
    const stats = imageStatsFromSampler(() => {
      const ink = index % 5 === 0; // 20% ink pixels
      index += 1;
      return ink ? { rgb: [0.1, 0.1, 0.1], alpha: 1 } : { rgb: [1, 1, 1], alpha: 1 };
    }, samples);
    expect(stats.nearWhiteFrac).toBeCloseTo(0.8, 5);
    expect(stats.meanSaturation).toBeLessThan(0.01);
    expect(stats.luminanceVariance).toBeGreaterThan(0.01);
  });

  it("recognizes a photo-like sample (colorful, little paper)", () => {
    const stats = imageStatsFromSampler(() => ({ rgb: [0.8, 0.2, 0.3], alpha: 1 }), 100);
    expect(stats.nearWhiteFrac).toBe(0);
    expect(stats.meanSaturation).toBeGreaterThan(0.4);
  });

  it("ignores transparent samples", () => {
    const stats = imageStatsFromSampler(() => ({ rgb: [1, 1, 1], alpha: 0 }), 10);
    // Nothing counted: the fallback reports an all-paper image.
    expect(stats.nearWhiteFrac).toBe(0);
    expect(stats.meanLuminance).toBe(1);
  });
});

describe("classifyRasterImage", () => {
  const paperStats: ImageStats = {
    nearWhiteFrac: 0.85,
    meanSaturation: 0.02,
    meanLuminance: 0.9,
    luminanceVariance: 0.04,
  };
  const photoStats: ImageStats = {
    nearWhiteFrac: 0.05,
    meanSaturation: 0.45,
    meanLuminance: 0.5,
    luminanceVariance: 0.08,
  };

  it("recolors a page-covering scanned paper image", () => {
    expect(classifyRasterImage(paperStats, 0.95)).toBe("recolor");
  });

  it("preserves a page-covering photo or cover", () => {
    expect(classifyRasterImage(photoStats, 0.95)).toBe("preserve");
  });

  it("preserves a colorful page-covering image (photo with sky, for one)", () => {
    // Above the paper threshold but too saturated to be paper.
    expect(classifyRasterImage({ ...paperStats, meanSaturation: 0.4 }, 0.95)).toBe("preserve");
  });

  it("preserves smaller illustrations regardless of statistics", () => {
    // A diagram occupying less than the page-coverage threshold keeps its
    // colors even when its own background is white paper.
    expect(classifyRasterImage(paperStats, PAGE_IMAGE_COVERAGE_THRESHOLD - 0.01)).toBe("preserve");
  });

  it("flags a barely-saturated full-bleed rasterized document page", () => {
    // Near the paper threshold: a rasterized text page (white background,
    // black text) is the canonical recolor case.
    const stats: ImageStats = {
      nearWhiteFrac: NEAR_WHITE_THRESHOLD,
      meanSaturation: 0.05,
      meanLuminance: 0.85,
      luminanceVariance: 0.05,
    };
    expect(classifyRasterImage(stats, 1)).toBe("recolor");
  });
});

describe("recolorPixelsInPlace", () => {
  it("flips scan paper to the dark background and ink to the light text", () => {
    // Pure black ink maps exactly onto the text color; near-black ink maps
    // proportionally (the luminance ramp).
    const pixels = new Uint8ClampedArray([255, 255, 255, 0, 0, 0, 255, 255, 255]);
    recolorPixelsInPlace(pixels, 3, 9, 1, PALETTE);
    const bg = PALETTE.background.map((v) => Math.round(v * 255));
    const text = PALETTE.text.map((v) => Math.round(v * 255));
    expect([...pixels.slice(0, 3)]).toEqual(bg);
    expect([...pixels.slice(3, 6)]).toEqual(text);
    expect([...pixels.slice(6, 9)]).toEqual(bg);
  });

  it("ramps near-black ink proportionally", () => {
    const pixels = new Uint8ClampedArray([26, 26, 26]);
    recolorPixelsInPlace(pixels, 3, 3, 1, PALETTE);
    // 26/255 ≈ 0.102 luminance → t ≈ 0.898 of the way to the text color.
    const expected = [0, 1, 2].map((index) =>
      Math.round(
        (PALETTE.background[index]! + (PALETTE.text[index]! - PALETTE.background[index]!) * 0.898) *
          255,
      ),
    );
    expect([...pixels.slice(0, 3)]).toEqual(expected);
  });

  it("preserves alpha and respects the row stride", () => {
    // 2 px per row, RGBA, one padded byte between rows (stride 9).
    const pixels = new Uint8ClampedArray([
      255,
      255,
      255,
      200,
      0,
      0,
      0,
      128, // row 1 (white opaque, red semi)
      0,
      0,
      0,
      255,
      128,
      128,
      128,
      255, // row 2 (black, mid-gray)
    ]);
    recolorPixelsInPlace(pixels, 4, 8, 2, PALETTE);
    expect(pixels[3]).toBe(200); // alpha untouched
    expect(pixels[7]).toBe(128);
    // White → background; black → text.
    expect(pixels[0]).toBe(Math.round(PALETTE.background[0] * 255));
    expect(pixels[1]).toBe(Math.round(PALETTE.background[1] * 255));
    expect(pixels[4]).toBe(Math.round(PALETTE.text[0] * 255));
    expect(pixels[5]).toBe(Math.round(PALETTE.text[1] * 255));
    expect(pixels[8]).toBe(Math.round(PALETTE.text[0] * 255));
  });

  it("keeps chromatic pixels' hue while compressing lightness", () => {
    // A blue pixel inside a scan stays blue-dominant after the transform.
    const pixels = new Uint8ClampedArray([11, 98, 196]);
    recolorPixelsInPlace(pixels, 3, 3, 1, PALETTE);
    expect(pixels[2]).toBeGreaterThan(pixels[0] ?? 0);
    expect(pixels[2]).toBeGreaterThan(pixels[1] ?? 0);
  });
});
