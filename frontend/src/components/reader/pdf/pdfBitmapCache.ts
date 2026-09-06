/**
 * LRU cache of rendered page bitmaps for the PDF reader (§ rendering
 * policy). A canvas that leaves the virtualization window is unmounted and
 * its pixels die with it; scrolling back used to re-run the full PDF.js
 * raster — brutally visible on heavy pages (full-bleed covers), where every
 * oscillation re-paid the whole render before the next page could start.
 * Evicted canvases now stash their offscreen buffer here, and re-entry
 * blits it in one synchronous draw instead of re-rendering.
 *
 * The cache is bounded twice over — a byte budget and an entry count — so
 * memory stays flat on any document (§ memory: avoid unbounded caches).
 * Entries are keyed by page and matched against the render scale and the
 * effective render ratio (pdfRenderPolicy), so a zoom change naturally
 * misses and a resize across monitors with a different devicePixelRatio
 * never serves a stale low-ratio bitmap (a miss just re-renders once);
 * explicit invalidation happens when the reader zooms and when the document
 * is swapped.
 */

/**
 * Total pixel-buffer bytes the cache may hold (RGBA, 4 bytes per pixel).
 * Sized against capped 4K page buffers (PERF-1 keeps each ≤ 2²⁵ px) at BOTH
 * reference device pixel ratios: at dpr 2 a capped 4K buffer is the full
 * 2²⁵ px ≈ 134 MB, so ≥ 2 retained buffers (PERF-3) needs ≥ 268 MB — the
 * earlier 192 MB flat budget silently degenerated to a single entry at
 * dpr 2. 320 MB holds two dpr-2 buffers with recency headroom.
 */
const DEFAULT_BUDGET_BYTES = 320 * 1024 * 1024;

/** Hard cap on cached pages regardless of byte size. */
const DEFAULT_MAX_ENTRIES = 8;

export interface PdfBitmap {
  readonly pageNumber: number;
  /** The PDF.js render scale the buffer was rasterized at. */
  readonly scale: number;
  /**
   * The effective render ratio (pdfRenderPolicy) the buffer was rasterized
   * at — exact-match keying, like `scale`, so a monitor change never
   * serves a buffer rendered for another devicePixelRatio.
   */
  readonly ratio: number;
  /** Offscreen (detached) canvas holding the rendered page pixels. */
  readonly buffer: HTMLCanvasElement;
}

function bitmapBytes(buffer: HTMLCanvasElement): number {
  return buffer.width * buffer.height * 4;
}

export class PdfBitmapCache {
  #entries = new Map<number, PdfBitmap>();
  #bytes = 0;
  readonly #maxBytes: number;
  readonly #maxEntries: number;

  constructor(maxBytes: number = DEFAULT_BUDGET_BYTES, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
  }

  /**
   * The cached bitmap for a page rendered at exactly `scale` and `ratio`,
   * or null. A successful lookup refreshes the entry's recency.
   */
  get(pageNumber: number, scale: number, ratio: number): PdfBitmap | null {
    const hit = this.#entries.get(pageNumber);
    if (!hit || hit.scale !== scale || hit.ratio !== ratio) return null;
    this.#entries.delete(pageNumber);
    this.#entries.set(pageNumber, hit);
    return hit;
  }

  /** Store a rendered bitmap, evicting the least recently used over budget. */
  put(bitmap: PdfBitmap): void {
    this.remove(bitmap.pageNumber);
    this.#entries.set(bitmap.pageNumber, bitmap);
    this.#bytes += bitmapBytes(bitmap.buffer);
    this.#trim();
  }

  remove(pageNumber: number): void {
    const existing = this.#entries.get(pageNumber);
    if (!existing) return;
    this.#bytes -= bitmapBytes(existing.buffer);
    this.#entries.delete(pageNumber);
  }

  /** Drop every entry (zoom change, document switch, reader teardown). */
  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  /** Number of cached bitmaps (diagnostics). */
  get size(): number {
    return this.#entries.size;
  }

  /** Approximate pixel bytes currently retained (diagnostics). */
  get byteSize(): number {
    return this.#bytes;
  }

  #trim(): void {
    while (this.#entries.size > 1) {
      if (this.#bytes <= this.#maxBytes && this.#entries.size <= this.#maxEntries) break;
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
  }
}
