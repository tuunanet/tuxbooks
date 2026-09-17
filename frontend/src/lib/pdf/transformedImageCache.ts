/**
 * Count-bounded LRU of transformed raster images (Smart Dark). The entries
 * are MuPDF `Image` handles that own a page-scale pixmap, so the cache owns
 * them: eviction and clear must call `destroy()`, not just forget the key.
 * The worker's garbage collector does not run often enough to release a
 * multi-megabyte native pixmap, so forgetting an entry leaks it into the
 * WASM heap until the renderer dies. Pure and MuPDF-free so the lifetime
 * rules are unit-tested without a WASM build.
 */

/** An entry the cache owns and must release when it drops the entry. */
export interface Destroyable {
  destroy(): void;
}

export class TransformedImageCache<T extends Destroyable> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  /** Look up an entry, refreshing its recency. Returns null on a miss. */
  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Re-insert to move the key to the back of the Map's iteration order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Store an entry, evicting (and destroying) the least recently used ones
   * past capacity. Replacing a key destroys the entry it displaces.
   */
  set(key: string, entry: T): void {
    const displaced = this.entries.get(key);
    if (displaced && displaced !== entry) displaced.destroy();
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      evicted?.destroy();
    }
  }

  /** Destroy and drop every entry. */
  clear(): void {
    for (const entry of this.entries.values()) entry.destroy();
    this.entries.clear();
  }
}
