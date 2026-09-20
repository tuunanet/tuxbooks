// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { PdfRangeSource, type RangeFetcher } from "@/lib/pdf/pdfRangeSource";
import { PdfiumEngine } from "@/lib/pdf/pdfiumCore";

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
