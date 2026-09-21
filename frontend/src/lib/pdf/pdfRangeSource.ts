/**
 * Random-access source for a range-backed PDF open. PDFium's
 * `FPDF_FILEACCESS.m_GetBlock` callback is synchronous and asks for arbitrary
 * byte spans, so reads go through synchronous XHR (legal only inside a
 * worker) against the `tuxbooks://book/<id>` protocol handler, which seeks
 * through the Rust sidecar. A bounded read-ahead chunk cache turns PDFium's
 * scattered object reads into a handful of range requests instead of one per
 * object (docs/PDF.md).
 *
 * The source never reads the whole file unless the file is smaller than one
 * chunk, or the protocol handler ignores the `Range` header.
 */

/** Default read-ahead chunk (1 MiB). */
export const RANGE_CHUNK_BYTES = 1024 * 1024;
/** Bounded chunk cache (≈64 MiB): enough locality, never unbounded growth. */
export const RANGE_MAX_CACHED_CHUNKS = 64;

export interface RangeResponse {
  status: number;
  body: ArrayBuffer;
  headers: Record<string, string>;
}

/**
 * One range request. Injectable so the cache can be unit-tested without a
 * worker or the `tuxbooks://` handler.
 */
export type RangeFetcher = (url: string, range: string) => RangeResponse;

function xhrRangeFetcher(url: string, range: string): RangeResponse {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.setRequestHeader("Range", range);
  xhr.responseType = "arraybuffer";
  xhr.send(null);
  const headers: Record<string, string> = {};
  const contentRange = xhr.getResponseHeader("content-range");
  if (contentRange !== null) headers["content-range"] = contentRange;
  return {
    status: xhr.status,
    body: (xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0),
    headers,
  };
}

export class PdfRangeSource {
  private size: number | null = null;
  private readonly chunks = new Map<number, ArrayBuffer>();

  constructor(
    private readonly url: string,
    private readonly fetchRange: RangeFetcher = xhrRangeFetcher,
    private readonly chunkBytes = RANGE_CHUNK_BYTES,
    private readonly maxChunks = RANGE_MAX_CACHED_CHUNKS,
  ) {}

  /**
   * Total file size from a one-byte range's `content-range` header, without
   * fetching the file. A range-unaware `200` body is the whole file, cached.
   */
  fileSize(): number {
    if (this.size !== null) return this.size;
    const response = this.fetchRange(this.url, "bytes=0-0");
    if (response.status === 206) {
      const total = /\/(\d+)$/.exec(response.headers["content-range"] ?? "")?.[1];
      if (!total) throw new Error("range response missing content-range total");
      this.size = Number(total);
    } else if (response.status === 200) {
      // Range-unaware response: the body is the whole file.
      this.size = response.body.byteLength;
      if (response.body.byteLength > 0) this.chunks.set(0, response.body);
    } else {
      throw new Error(`failed to stat ${this.url}: ${response.status}`);
    }
    return this.size;
  }

  /**
   * Copies `length` bytes at `position` into `memory` at `offset`, walking
   * the chunk cache. Returns the number of bytes written; the PDFium
   * `m_GetBlock` contract wants 0 past EOF.
   */
  read(memory: Uint8Array, offset: number, length: number, position: number): number {
    const total = this.fileSize();
    if (position >= total) return 0;
    const end = Math.min(position + length, total);
    let cursor = position;
    while (cursor < end) {
      const chunkIndex = Math.floor(cursor / this.chunkBytes);
      const chunk = this.chunk(chunkIndex, total);
      const chunkStart = chunkIndex * this.chunkBytes;
      const from = cursor - chunkStart;
      const count = Math.min(end - cursor, chunk.byteLength - from);
      if (count <= 0) throw new Error(`range read stalled at ${this.url}@${cursor}`);
      memory.set(new Uint8Array(chunk, from, count), offset + (cursor - position));
      cursor += count;
    }
    return end - position;
  }

  close(): void {
    this.chunks.clear();
  }

  private chunk(chunkIndex: number, total: number): ArrayBuffer {
    const cached = this.chunks.get(chunkIndex);
    if (cached) {
      // Refresh for LRU order (Map iteration is insertion-ordered).
      this.chunks.delete(chunkIndex);
      this.chunks.set(chunkIndex, cached);
      return cached;
    }
    const start = chunkIndex * this.chunkBytes;
    const end = Math.min(start + this.chunkBytes, total) - 1;
    const response = this.fetchRange(this.url, `bytes=${start}-${end}`);
    let body: ArrayBuffer;
    if (response.status === 206) {
      body = response.body;
    } else if (response.status === 200) {
      // Range-unaware response: the body is the whole file; slice it.
      body = response.body.slice(start, end + 1);
    } else {
      throw new Error(`failed to read ${this.url}@${start}-${end}: ${response.status}`);
    }
    this.chunks.set(chunkIndex, body);
    while (this.chunks.size > this.maxChunks) {
      const oldest = this.chunks.keys().next().value;
      if (oldest === undefined) break;
      this.chunks.delete(oldest);
    }
    return body;
  }
}
