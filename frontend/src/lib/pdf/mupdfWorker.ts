/**
 * The MuPDF worker: every MuPDF/WASM object lives here, and all rasterization
 * and text extraction run off the UI thread (docs/pdf.md). One worker instance
 * serves one document; the main-thread side (pdfEngine.ts) terminates the
 * worker when the document closes, which frees the whole WASM heap.
 *
 * Protocol: request `{ id, method, params }`, response
 * `{ id, ok: true, result }` / `{ id, ok: false, error }`. Render responses
 * transfer an ImageBitmap; the open request transfers the PDF bytes.
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
      params: { wasmUrl: string; data: ArrayBuffer; offset: number; length: number };
    }
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
  async open({
    wasmUrl,
    data,
    offset,
    length,
  }: {
    wasmUrl: string;
    data: ArrayBuffer;
    offset: number;
    length: number;
  }): Promise<{ pageCount: number }> {
    const mod = await ensureEngine(wasmUrl);
    document?.destroy();
    const view = new Uint8Array(data, offset, length);
    document = mod.Document.openDocument(view, "application/pdf");
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
