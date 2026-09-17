import { describe, expect, test, vi } from "vitest";

import { TransformedImageCache } from "@/lib/pdf/transformedImageCache";

/**
 * Lifetime rules for the Smart Dark transformed-image LRU (docs/PDF.md).
 * The entries own native MuPDF pixmaps; the worker's GC is too lazy to free
 * them, so every path that drops an entry (eviction, replacement, clear)
 * must destroy it. A fake entry stands in for the engine handle.
 */

interface FakeImage {
  id: number;
  destroys: number;
  destroy(): void;
}

function image(id: number): FakeImage {
  return {
    id,
    destroys: 0,
    destroy: vi.fn(function (this: FakeImage) {
      this.destroys += 1;
    }),
  };
}

describe("TransformedImageCache", () => {
  test("destroys the least recently used entry on eviction", () => {
    const cache = new TransformedImageCache<FakeImage>(2);
    const a = image(1);
    const b = image(2);
    const c = image(3);

    cache.set("a", a);
    cache.set("b", b);
    expect(cache.size).toBe(2);

    cache.set("c", c);
    expect(cache.size).toBe(2);
    expect(a.destroys).toBe(1);
    expect(b.destroys).toBe(0);
    expect(c.destroys).toBe(0);
  });

  test("a hit refreshes recency and protects the entry from eviction", () => {
    const cache = new TransformedImageCache<FakeImage>(2);
    const a = image(1);
    const b = image(2);
    const c = image(3);

    cache.set("a", a);
    cache.set("b", b);
    expect(cache.get("a")).toBe(a);

    cache.set("c", c);
    expect(b.destroys).toBe(1);
    expect(a.destroys).toBe(0);
    expect(cache.get("a")).toBe(a);
  });

  test("clear destroys every live entry", () => {
    const cache = new TransformedImageCache<FakeImage>(3);
    const a = image(1);
    const b = image(2);
    cache.set("a", a);
    cache.set("b", b);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(a.destroys).toBe(1);
    expect(b.destroys).toBe(1);
  });

  test("replacing a key destroys the entry it displaces", () => {
    const cache = new TransformedImageCache<FakeImage>(2);
    const first = image(1);
    const second = image(2);
    cache.set("a", first);
    cache.set("a", second);

    expect(first.destroys).toBe(1);
    expect(second.destroys).toBe(0);
    expect(cache.get("a")).toBe(second);
  });

  test("a miss returns null and does not disturb the cache", () => {
    const cache = new TransformedImageCache<FakeImage>(1);
    const a = image(1);
    cache.set("a", a);
    expect(cache.get("missing")).toBeNull();
    expect(a.destroys).toBe(0);
  });
});
