/**
 * The MuPDF worker: every MuPDF/WASM object lives here, and all rasterization
 * and text extraction run off the UI thread (docs/PDF.md). One worker instance
 * serves one document; the main-thread side (pdfEngine.ts) terminates the
 * worker when the document closes, which frees the whole WASM heap.
 *
 * Protocol: request `{ id, method, params }`, response
 * `{ id, ok: true, result }` / `{ id, ok: false, error }`. Render responses
 * transfer an ImageBitmap. Open accepts either transferred PDF bytes or a
 * `bookUrl` (`tuxbooks://book/<id>`), which is opened through a
 * random-access `mupdf.Stream` whose reads become HTTP Range requests —
 * so a document opens (and page 1 renders) long before the whole file has
 * crossed the bridge.
 *
 * The library is imported lazily on the first `open`: the emscripten glue
 * resolves its `mupdf-wasm.wasm` through `Module.locateFile` at import time,
 * and the bundler's default resolution (relative to the worker chunk) never
 * finds the asset — so the main thread passes an absolute URL in the open
 * request and the global is pinned before the dynamic import.
 */

type WorkerRequest =
  | {
      id: number;
      method: "open";
      params:
        | { wasmUrl: string; data: ArrayBuffer; offset: number; length: number }
        | { wasmUrl: string; bookUrl: string };
    }
  | { id: number; method: "prewarm"; params: { wasmUrl: string } }
  | { id: number; method: "pageSize"; params: { page: number } }
  | { id: number; method: "render"; params: { page: number; width: number; height: number } }
  | { id: number; method: "text"; params: { page: number } }
  | { id: number; method: "outline"; params?: undefined };

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type MupdfModule = typeof import("mupdf");
type MupdfDocument = InstanceType<MupdfModule["Document"]>;

let mupdf: MupdfModule | null = null;
let document: MupdfDocument | null = null;

async function ensureEngine(wasmUrl: string): Promise<MupdfModule> {
  if (!mupdf) {
    // mupdf.js reads this global when the emscripten glue initializes, so it
    // must exist before the dynamic import resolves the module body.
    (globalThis as { $libmupdf_wasm_Module?: unknown }).$libmupdf_wasm_Module = {
      locateFile: () => wasmUrl,
    };
    mupdf = await import("mupdf");
  }
  return mupdf;
}

/**
 * Default read-ahead chunk for range-backed documents (1 MiB). MuPDF reads
 * the xref trail, page tree, and page 1 content from scattered offsets; a
 * chunk cache turns those scatter reads into a handful of range requests
 * instead of one per object.
 */
const STREAM_CHUNK_BYTES = 1024 * 1024;
/** Bounded chunk cache (≈64 MiB): enough locality, never unbounded growth. */
const STREAM_MAX_CACHED_CHUNKS = 64;

/**
 * Random-access adapter over `tuxbooks://book/<id>` for `mupdf.Stream`.
 * MuPDF's stream callbacks are synchronous, so reads use synchronous XHR —
 * legal (and only legal) inside a worker — and block this worker exactly
 * like the synchronous rasterization it interleaves with. Each miss fetches
 * one `STREAM_CHUNK_BYTES` range from the sidecar through the Electron
 * protocol handler; `fileSize()` reads the total out of a one-byte range's
 * `content-range` header.
 */
class RangeStreamHandle {
  private readonly chunks = new Map<number, ArrayBuffer>();
  private size: number | null = null;

  constructor(
    private readonly bookUrl: string,
    private readonly chunkBytes = STREAM_CHUNK_BYTES,
  ) {}

  fileSize(): number {
    if (this.size === null) {
      // A 1-byte range returns 206 with `content-range: bytes 0-0/TOTAL`;
      // parse the total out of it without ever fetching the file.
      const response = this.request("bytes=0-0");
      if (response.status === 206) {
        const total = /\/(\d+)$/.exec(response.headers["content-range"] ?? "")?.[1];
        if (!total) throw new Error("range response missing content-range total");
        this.size = Number(total);
      } else if (response.status === 200) {
        // Range-unaware response: the body is the whole file.
        this.size = response.body.byteLength;
        if (response.body.byteLength > 0) {
          this.chunks.set(0, response.body);
        }
      } else {
        throw new Error(`failed to stat ${this.bookUrl}: ${response.status}`);
      }
    }
    return this.size;
  }

  read(memory: Uint8Array, offset: number, length: number, position: number): number {
    const total = this.fileSize();
    if (position >= total) return 0;
    const end = Math.min(position + length, total);
    let cursor = position;
    while (cursor < end) {
      const chunkIndex = Math.floor(cursor / this.chunkBytes);
      const chunk = new Uint8Array(this.chunk(chunkIndex, total));
      const chunkStart = chunkIndex * this.chunkBytes;
      const from = cursor - chunkStart;
      const count = Math.min(end - cursor, chunk.length - from);
      memory.set(chunk.subarray(from, from + count), offset + (cursor - position));
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
    const response = this.request(`bytes=${start}-${end}`);
    let body: ArrayBuffer;
    if (response.status === 206) {
      body = response.body;
    } else if (response.status === 200) {
      // Range-unaware response: the body is the whole file; slice it.
      body = response.body.slice(start, end + 1);
    } else {
      throw new Error(`failed to read ${this.bookUrl}@${start}-${end}: ${response.status}`);
    }
    this.chunks.set(chunkIndex, body);
    while (this.chunks.size > STREAM_MAX_CACHED_CHUNKS) {
      const oldest = this.chunks.keys().next().value;
      if (oldest === undefined) break;
      this.chunks.delete(oldest);
    }
    return body;
  }

  private request(range: string): {
    status: number;
    body: ArrayBuffer;
    headers: Record<string, string>;
  } {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", this.bookUrl, false);
    xhr.setRequestHeader("Range", range);
    xhr.responseType = "arraybuffer";
    xhr.send(null);
    const headers: Record<string, string> = {};
    for (const name of ["content-range"]) {
      const value = xhr.getResponseHeader(name);
      if (value !== null) headers[name] = value;
    }
    return {
      status: xhr.status,
      body: (xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0),
      headers,
    };
  }
}

/** One structured-text line, in page units (points); `y` is the baseline. */
interface TextLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
}

function extractLines(doc: MupdfDocument, page: number): TextLine[] {
  const loaded = doc.loadPage(page - 1);
  try {
    const stext = loaded.toStructuredText("preserve-whitespace");
    try {
      const json = JSON.parse(stext.asJSON()) as {
        blocks: {
          type: string;
          lines?: {
            text: string;
            bbox: { x: number; y: number; w: number; h: number };
            font?: { size: number };
          }[];
        }[];
      };
      const lines: TextLine[] = [];
      for (const block of json.blocks) {
        if (block.type !== "text") continue;
        for (const line of block.lines ?? []) {
          if (line.text === "") continue;
          lines.push({
            text: line.text,
            x: line.bbox.x,
            y: line.bbox.y,
            w: line.bbox.w,
            h: line.bbox.h,
            size: line.font?.size ?? line.bbox.h,
          });
        }
      }
      return lines;
    } finally {
      stext.destroy();
    }
  } finally {
    loaded.destroy();
  }
}

const methods = {
  async prewarm({ wasmUrl }: { wasmUrl: string }): Promise<{ ready: boolean }> {
    // Engine load only: no document, no allocation, no rasterization.
    await ensureEngine(wasmUrl);
    return { ready: true };
  },

  async open(params: {
    wasmUrl: string;
    data?: ArrayBuffer;
    offset?: number;
    length?: number;
    bookUrl?: string;
  }): Promise<{ pageCount: number }> {
    const mod = await ensureEngine(params.wasmUrl);
    document?.destroy();
    if (params.bookUrl !== undefined) {
      // Range-backed open: MuPDF pulls only the ranges it needs (xref trail
      // first, page 1 content next) straight off tuxbooks://.
      const handle = new RangeStreamHandle(params.bookUrl);
      document = mod.Document.openDocument(new mod.Stream(handle), "application/pdf");
    } else {
      const data = params.data;
      if (data === undefined) throw new Error("open requires data or bookUrl");
      const view = new Uint8Array(data, params.offset, params.length);
      document = mod.Document.openDocument(view, "application/pdf");
    }
    return { pageCount: document.countPages() };
  },

  pageSize({ page }: { page: number }): { width: number; height: number } {
    if (!mupdf || !document) throw new Error("no document open");
    const loaded = document.loadPage(page - 1);
    try {
      const bounds = loaded.getBounds();
      const [x0, y0, x1, y1] = bounds;
      if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) {
        throw new Error(`page ${page} has no bounds`);
      }
      return { width: x1 - x0, height: y1 - y0 };
    } finally {
      loaded.destroy();
    }
  },

  async render({
    page,
    width,
    height,
  }: {
    page: number;
    width: number;
    height: number;
  }): Promise<{ width: number; height: number; bitmap: ImageBitmap }> {
    if (!mupdf || !document) throw new Error("no document open");
    const loaded = document.loadPage(page - 1);
    try {
      const [x0, y0, x1, y1] = loaded.getBounds();
      const pageWidth = x1 - x0;
      const pageHeight = y1 - y0;
      const pixmap = loaded.toPixmap(
        mupdf.Matrix.scale(width / pageWidth, height / pageHeight),
        mupdf.ColorSpace.DeviceRGB,
        true,
      );
      try {
        // getPixels() is a view into the WASM heap; the copy here detaches
        // it, and createImageBitmap lets the bitmap transfer to the main
        // thread without a second copy.
        const pixels = new Uint8ClampedArray(pixmap.getPixels());
        const imageData = new ImageData(pixels, pixmap.getWidth(), pixmap.getHeight());
        const bitmap = await createImageBitmap(imageData);
        return { width: bitmap.width, height: bitmap.height, bitmap };
      } finally {
        pixmap.destroy();
      }
    } finally {
      loaded.destroy();
    }
  },

  text({ page }: { page: number }): { lines: TextLine[] } {
    if (!mupdf || !document) throw new Error("no document open");
    return { lines: extractLines(document, page) };
  },

  outline(): { items: unknown } {
    if (!mupdf || !document) throw new Error("no document open");
    const normalize = (items: ReturnType<MupdfDocument["loadOutline"]>): unknown =>
      (items ?? []).map((item) => ({
        // Outline pages are 0-based; external links carry no page. The
        // 1-based conversion stays in pdfOutline.ts (pure, unit-tested).
        title: item.title ?? "",
        page: typeof item.page === "number" && item.page >= 0 ? item.page : null,
        items: normalize(item.down ?? []),
      }));
    return { items: normalize(document.loadOutline()) };
  },
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const respond = (response: WorkerResponse, transfer: Transferable[] = []): void => {
    (self as unknown as Worker).postMessage(response, transfer);
  };
  try {
    const method = methods[request.method as keyof typeof methods];
    if (!method) throw new Error(`unknown method ${request.method}`);
    const params = request.params as never;
    const result = (await (method as (p: never) => unknown)(params)) as { bitmap?: ImageBitmap };
    if (result?.bitmap instanceof ImageBitmap) {
      // The bitmap is transferred in place: the structured clone keeps the
      // property, the transfer list moves the pixel buffer itself.
      respond({ id: request.id, ok: true, result }, [result.bitmap]);
      return;
    }
    respond({ id: request.id, ok: true, result });
  } catch (error: unknown) {
    respond({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
