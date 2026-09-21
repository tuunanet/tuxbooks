// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { MAX_RENDER_PIXELS_HARD, regionRenderRatio } from "@/components/reader/pdf/pdfRenderPolicy";
import { PdfRangeSource, type RangeFetcher } from "@/lib/pdf/pdfRangeSource";
import { PdfiumEngine, type PageClip } from "@/lib/pdf/pdfiumCore";

/**
 * Real PDFium-WASM integration (tuxbooks-koe.5). Loading the browser build
 * under vitest's jsdom is impractical (the Emscripten glue wants a Worker or
 * Node fs), so this test runs in the Node environment against the package's
 * Node build and drives the same `PdfiumEngine` the worker uses: open from
 * bytes and range-backed, page count, page sizes, and whole-page raster.
 *
 * The fixture is the committed 3-page, 612×792 `minimal.pdf`. The worker
 * transport and the reader path are covered by the jsdom adapter test and the
 * engine E2E smoke.
 */

const wasmPath = fileURLToPath(
  new URL("../node_modules/@embedpdf/pdfium/dist/pdfium.wasm", import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL("../../tests/fixtures/books/minimal.pdf", import.meta.url),
);

/** Exact-length ArrayBuffer copy (Buffer views share a pooled backing store). */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function countNonWhite(rgba: Uint8ClampedArray<ArrayBuffer>): number {
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i]! < 240 || rgba[i + 1]! < 240 || rgba[i + 2]! < 240) count += 1;
  }
  return count;
}

/** Copies a sub-rectangle out of a packed RGBA buffer. */
function cropRgba(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  bufferWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  const crop = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * bufferWidth + x) * 4;
    crop.set(rgba.subarray(from, from + width * 4), row * width * 4);
  }
  return crop;
}

let engine: PdfiumEngine | null = null;

afterEach(() => {
  engine?.destroy();
  engine = null;
});

describe("PdfiumEngine (WASM)", () => {
  test("opens bytes, reports page sizes, and rasterizes a whole page", async () => {
    const wasm = readFileSync(wasmPath);
    engine = await PdfiumEngine.load({ wasmBinary: toArrayBuffer(wasm) });
    const file = readFileSync(fixturePath);

    const pageCount = engine.openBytes(toArrayBuffer(file));

    expect(pageCount).toBe(3);
    expect(engine.pageSize(0)).toEqual({ width: 612, height: 792 });
    expect(engine.pageSize(2)).toEqual({ width: 612, height: 792 });

    const rgba = engine.renderRgba(0, 122, 158);
    expect(rgba.length).toBe(122 * 158 * 4);
    expect(countNonWhite(rgba)).toBeGreaterThan(0);
  });

  test("extracts text lines with page-unit geometry", async () => {
    const wasm = readFileSync(wasmPath);
    engine = await PdfiumEngine.load({ wasmBinary: toArrayBuffer(wasm) });
    const file = readFileSync(fixturePath);
    engine.openBytes(toArrayBuffer(file));

    const lines = engine.textLines(0);
    expect(lines.map((line) => line.text)).toEqual(["Tuxbooks PDF Fixture", "Page 1 of 3"]);

    // Page units, top-left origin (y down). The reference line is
    // x=72,y=229,w=397,h=54,size=40 from MuPDF's structured text; PDFium's
    // loose character boxes land within a few points and keep font size.
    const [title, body] = lines;
    expect(title!.x).toBeCloseTo(72, 0);
    expect(title!.y).toBeCloseTo(234.2, 0);
    expect(title!.w).toBeCloseTo(397.9, 0);
    expect(title!.h).toBeCloseTo(46.8, 0);
    expect(title!.size).toBe(40);

    expect(body!.text).toBe("Page 1 of 3");
    expect(body!.x).toBeCloseTo(72, 0);
    expect(body!.size).toBe(28);

    // The page argument selects the page: page 2 differs only in its marker.
    expect(engine.textLines(1).map((line) => line.text)).toEqual([
      "Tuxbooks PDF Fixture",
      "Page 2 of 3",
    ]);
  });

  test("rasterizes a clipped region aligned to the whole page", async () => {
    const wasm = readFileSync(wasmPath);
    engine = await PdfiumEngine.load({ wasmBinary: toArrayBuffer(wasm) });
    const file = readFileSync(fixturePath);
    engine.openBytes(toArrayBuffer(file));

    // Page 1 text sits at roughly y 243–338; x 72–470 (pdftotext -bbox).
    const clip: PageClip = [72, 243, 378, 40];
    const width = 378;
    const height = 40;
    const region = engine.renderRgba(0, width, height, clip);

    expect(region.length).toBe(width * height * 4);
    expect(countNonWhite(region)).toBeGreaterThan(0);

    // The region must match the same crop of a 1:1 whole-page raster: same
    // content, same page offset, same device scale.
    const whole = engine.renderRgba(0, 612, 792);
    const expected = cropRgba(whole, 612, 72, 243, width, height);
    let mismatches = 0;
    for (let i = 0; i < region.length; i += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        if (Math.abs(region[i + channel]! - expected[i + channel]!) > 8) {
          mismatches += 1;
          break;
        }
      }
    }
    expect(mismatches / (width * height)).toBeLessThan(0.02);

    // A blank band below the text renders white: the page offset is applied,
    // not defaulted to the page origin.
    const blank = engine.renderRgba(0, width, height, [72, 520, 378, 40]);
    expect(countNonWhite(blank)).toBe(0);
  });

  test("keeps a deep-zoom region inside the pixel budget", async () => {
    const wasm = readFileSync(wasmPath);
    engine = await PdfiumEngine.load({ wasmBinary: toArrayBuffer(wasm) });
    const file = readFileSync(fixturePath);
    engine.openBytes(toArrayBuffer(file));

    // The reader sizes region buffers with regionRenderRatio (PERF-17); at
    // deep zoom the ratio stays at dpr instead of the whole-page cap, so the
    // region-sized buffer never exceeds the hard pixel budget.
    const regionWidth = 800;
    const regionHeight = 600;
    const ratio = regionRenderRatio(regionWidth, regionHeight, 2);
    const width = Math.max(1, Math.round(regionWidth * ratio));
    const height = Math.max(1, Math.round(regionHeight * ratio));
    expect(width * height).toBeLessThanOrEqual(MAX_RENDER_PIXELS_HARD);

    const rgba = engine.renderRgba(0, width, height, [200, 280, regionWidth, regionHeight]);
    expect(rgba.length).toBe(width * height * 4);
  });

  test("opens range-backed through FPDF_FILEACCESS with a chunked source", async () => {
    const wasm = readFileSync(wasmPath);
    engine = await PdfiumEngine.load({ wasmBinary: toArrayBuffer(wasm) });
    const file = readFileSync(fixturePath);
    const calls: Array<{ start: number; end: number }> = [];
    const fetcher: RangeFetcher = (_url, range) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) throw new Error(`unexpected range ${range}`);
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), file.length - 1);
      const body = toArrayBuffer(file.subarray(start, end + 1));
      calls.push({ start, end });
      return {
        status: 206,
        body,
        headers: { "content-range": `bytes ${start}-${end}/${file.length}` },
      };
    };
    const source = new PdfRangeSource("tuxbooks://book/1?format=pdf", fetcher, 256);

    const pageCount = engine.openRange(source);

    expect(pageCount).toBe(3);
    expect(engine.pageSize(0)).toEqual({ width: 612, height: 792 });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.start).toBeGreaterThanOrEqual(0);
      expect(call.end).toBeLessThan(file.length);
    }
  });
});
