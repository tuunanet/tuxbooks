// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { clampBitmapSize, MAX_RENDER_BITMAP_PIXELS, PdfiumEngine } from "@/lib/pdf/pdfiumCore";

const wasmPath = fileURLToPath(
  new URL("../node_modules/@embedpdf/pdfium/dist/pdfium.wasm", import.meta.url),
);
const plotPath = fileURLToPath(
  new URL("../../tests/fixtures/pdf/plots/dphi_GRANIITTI_MC.pdf", import.meta.url),
);

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

describe("clampBitmapSize", () => {
  it("leaves a within-budget size unchanged", () => {
    expect(clampBitmapSize(1000, 1000)).toEqual({ width: 1000, height: 1000 });
  });

  it("shrinks an oversized bitmap to the budget, preserving aspect", () => {
    const { width, height } = clampBitmapSize(27950, 24850);
    expect(width * height).toBeLessThanOrEqual(MAX_RENDER_BITMAP_PIXELS);
    expect(width / height).toBeCloseTo(27950 / 24850, 2);
  });
});

describe("PdfiumEngine bitmap cap", () => {
  it("renders an oversized whole-page request without exhausting the heap", async () => {
    const engine = await PdfiumEngine.load({ wasmBinary: toArrayBuffer(readFileSync(wasmPath)) });
    engine.openBytes(toArrayBuffer(readFileSync(plotPath)));
    // A whole plot page at scale 100 (10000%): 27,950 x 24,850 CSS pixels,
    // ~694 MP -- far past the 2 GB WASM heap. Before the cap this asked
    // FPDFBitmap_Create for ~2.8 GB and the renderer was killed.
    const rgba = engine.renderRgba(0, 27950, 24850);
    const pixels = rgba.length / 4;
    expect(pixels).toBeGreaterThan(0);
    expect(pixels).toBeLessThanOrEqual(MAX_RENDER_BITMAP_PIXELS);
  }, 120_000);
});
