import { describe, expect, it } from "vitest";

import { PdfBitmapCache, type PdfBitmap } from "@/components/reader/pdf/pdfBitmapCache";

function bitmap(pageNumber: number, scale: number, width: number, height: number): PdfBitmap {
  return {
    pageNumber,
    scale,
    buffer: { width, height } as HTMLCanvasElement,
  };
}

describe("PdfBitmapCache", () => {
  it("returns stored bitmaps and refreshes recency on hit", () => {
    const cache = new PdfBitmapCache(1024, 2);
    cache.put(bitmap(1, 1, 8, 8));
    cache.put(bitmap(2, 1, 8, 8));

    expect(cache.get(1, 1)?.pageNumber).toBe(1);
    expect(cache.size).toBe(2);

    // Page 1 was just touched, so page 2 is now the LRU entry: a third put
    // under the entry cap must evict page 2, not page 1.
    cache.put(bitmap(3, 1, 8, 8));
    expect(cache.get(1, 1)).not.toBeNull();
    expect(cache.get(2, 1)).toBeNull();
    expect(cache.get(3, 1)).not.toBeNull();
  });

  it("misses when the render scale differs", () => {
    const cache = new PdfBitmapCache();
    cache.put(bitmap(1, 1, 8, 8));
    expect(cache.get(1, 1)).not.toBeNull();
    expect(cache.get(1, 1.5)).toBeNull();
  });

  it("misses for unknown pages", () => {
    const cache = new PdfBitmapCache();
    expect(cache.get(9, 1)).toBeNull();
  });

  it("evicts by byte budget, oldest first", () => {
    // Budget fits exactly two 16x16 RGBA buffers (2048 bytes).
    const cache = new PdfBitmapCache(2048, 10);
    cache.put(bitmap(1, 1, 16, 16));
    cache.put(bitmap(2, 1, 16, 16));
    expect(cache.byteSize).toBe(2048);

    cache.put(bitmap(3, 1, 16, 16));
    expect(cache.get(1, 1)).toBeNull();
    expect(cache.get(2, 1)).not.toBeNull();
    expect(cache.get(3, 1)).not.toBeNull();
    expect(cache.byteSize).toBe(2048);
  });

  it("always keeps the most recently inserted bitmap even when oversized", () => {
    const cache = new PdfBitmapCache(64, 10);
    cache.put(bitmap(1, 1, 64, 64));
    expect(cache.get(1, 1)).not.toBeNull();
    expect(cache.size).toBe(1);
  });

  it("replacing a page replaces its byte accounting", () => {
    const cache = new PdfBitmapCache(4096, 10);
    cache.put(bitmap(1, 1, 16, 16));
    cache.put(bitmap(1, 1.5, 24, 24));
    expect(cache.size).toBe(1);
    expect(cache.byteSize).toBe(24 * 24 * 4);
  });

  it("remove and clear drop entries and bytes", () => {
    const cache = new PdfBitmapCache();
    cache.put(bitmap(1, 1, 8, 8));
    cache.put(bitmap(2, 1, 8, 8));
    cache.remove(1);
    expect(cache.get(1, 1)).toBeNull();
    expect(cache.byteSize).toBe(8 * 8 * 4);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
    expect(cache.get(2, 1)).toBeNull();
  });
});
