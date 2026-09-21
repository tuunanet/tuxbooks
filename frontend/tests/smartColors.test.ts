import { describe, expect, it } from "vitest";
import {
  colorSchemeFromPalette,
  hexToRgb01,
  rgbToArgb,
  FPDF_CONVERT_FILL_TO_STROKE,
  type SmartPalette,
} from "@/lib/pdf/smartColors";

/** The palette theme.ts derives from the EPUB dark preset. */
const PALETTE: SmartPalette = {
  background: hexToRgb01("#101013") as [number, number, number],
  text: hexToRgb01("#e4e4e7") as [number, number, number],
};

describe("colorSchemeFromPalette", () => {
  it("encodes RGB as opaque 0xAARRGGBB", () => {
    expect(rgbToArgb([0, 0, 0])).toBe(0xff000000);
    expect(rgbToArgb([1, 1, 1])).toBe(0xffffffff);
    expect(rgbToArgb([1, 0, 0])).toBe(0xffff0000);
    expect(rgbToArgb([0x12 / 255, 0x34 / 255, 0x56 / 255])).toBe(0xff123456);
  });

  it("maps the dark palette onto the four colour-scheme categories", () => {
    // The page background is the path fill, text the light colour; the cross
    // terms are the opposite endpoint so strokes and converted fills stay
    // visible against their fill.
    expect(colorSchemeFromPalette(PALETTE)).toEqual({
      pathFill: 0xff101013,
      pathStroke: 0xffe4e4e7,
      textFill: 0xffe4e4e7,
      textStroke: 0xff101013,
    });
  });

  it("carries the fill-to-stroke flag PDFium needs for adjacent fills", () => {
    expect(FPDF_CONVERT_FILL_TO_STROKE).toBe(0x20);
  });
});
