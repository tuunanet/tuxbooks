import { describe, expect, test } from "vitest";

import { PdfRangeSource, type RangeFetcher } from "@/lib/pdf/pdfRangeSource";

/**
 * The PDFium range source (tuxbooks-koe.5): a bounded read-ahead chunk cache
 * over range requests. The tests use an injected fetcher, so they pin the
 * cache's external behaviour (chunk reuse, LRU bound, never reading the whole
 * file) without a worker or the `tuxbooks://` handler.
 */

/** Deterministic byte source with range bookkeeping. */
function makeRangeServer(total: number) {
  const data = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) data[i] = i % 251;
  const calls: Array<{ start: number; end: number }> = [];
  let bytesServed = 0;
  const fetcher: RangeFetcher = (_url, range) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) throw new Error(`unexpected range ${range}`);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), total - 1);
    if (start > end) {
      return { status: 206, body: new ArrayBuffer(0), headers: { "content-range": `*/${total}` } };
    }
    const body = data.slice(start, end + 1).buffer as ArrayBuffer;
    calls.push({ start, end });
    bytesServed += body.byteLength;
    return {
      status: 206,
      body,
      headers: { "content-range": `bytes ${start}-${end}/${total}` },
    };
  };
  return {
    data,
    calls,
    fetcher,
    total,
    bytesServed: () => bytesServed,
  };
}

describe("PdfRangeSource", () => {
  test("reads a span across chunk boundaries byte-exactly", () => {
    const server = makeRangeServer(20);
    const source = new PdfRangeSource("tuxbooks://book/1?format=pdf", server.fetcher, 8);

    const memory = new Uint8Array(12);
    const read = source.read(memory, 0, memory.length, 5);

    expect(read).toBe(12);
    expect([...memory]).toEqual([...server.data.subarray(5, 17)]);
    // Chunks 0 (bytes 0-7), 1 (8-15), and 2 (16-23) serve the span; the
    // one-byte stat request is excluded.
    const chunkStarts = server.calls
      .filter((call) => call.end > call.start)
      .map((call) => call.start);
    expect(chunkStarts).toEqual([0, 8, 16]);
  });

  test("reuses cached chunks for later reads", () => {
    const server = makeRangeServer(64);
    const source = new PdfRangeSource("tuxbooks://book/1?format=pdf", server.fetcher, 16);

    source.read(new Uint8Array(4), 0, 4, 2);
    const afterFirst = server.calls.length;
    source.read(new Uint8Array(4), 0, 4, 4);

    expect(server.calls.length).toBe(afterFirst);
  });

  test("evicts the least recently used chunk past the bound", () => {
    const server = makeRangeServer(64);
    const source = new PdfRangeSource("tuxbooks://book/1?format=pdf", server.fetcher, 16, 2);

    source.read(new Uint8Array(4), 0, 4, 0); // chunk 0
    source.read(new Uint8Array(4), 0, 4, 16); // chunk 1
    source.read(new Uint8Array(4), 0, 4, 32); // chunk 2 evicts chunk 0
    const beforeRevisit = server.calls.length;
    source.read(new Uint8Array(4), 0, 4, 0); // chunk 0 refetched

    expect(server.calls.length).toBe(beforeRevisit + 1);
  });

  test("reads a small span without ever transferring the whole file", () => {
    const total = 8 * 1024 * 1024;
    const server = makeRangeServer(total);
    const source = new PdfRangeSource("tuxbooks://book/1?format=pdf", server.fetcher);

    source.read(new Uint8Array(16), 0, 16, 5 * 1024 * 1024);

    // One stat request (1 byte) plus at most two 1 MiB chunks for a 16-byte
    // span that straddles a chunk boundary.
    expect(server.bytesServed()).toBeLessThan(3 * 1024 * 1024);
    expect(server.bytesServed()).toBeLessThan(total);
  });

  test("handles a range-unaware 200 response by slicing the body", () => {
    const whole = new Uint8Array(32);
    for (let i = 0; i < whole.length; i += 1) whole[i] = i;
    const body = whole.buffer as ArrayBuffer;
    const fetcher: RangeFetcher = () => ({ status: 200, body, headers: {} });
    const source = new PdfRangeSource("tuxbooks://book/1?format=pdf", fetcher, 8);

    expect(source.fileSize()).toBe(32);
    const memory = new Uint8Array(5);
    expect(source.read(memory, 0, 5, 9)).toBe(5);
    expect([...memory]).toEqual([9, 10, 11, 12, 13]);
  });

  test("refuses a URL that is not the app's book protocol", () => {
    // The URL arrives over postMessage; the source must not turn arbitrary
    // input into a request (js/client-side-request-forgery).
    const fetcher: RangeFetcher = () => ({ status: 206, body: new ArrayBuffer(0), headers: {} });
    expect(() => new PdfRangeSource("https://evil.example/steal.pdf", fetcher)).toThrow(
      /not a book URL/,
    );
    expect(() => new PdfRangeSource("tuxbooks://book/../../etc/passwd", fetcher)).toThrow(
      /not a book URL/,
    );
  });
});
