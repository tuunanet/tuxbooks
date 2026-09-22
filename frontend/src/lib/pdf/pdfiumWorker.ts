/**
 * The PDFium worker (ADR 0002): every PDFium/WASM object lives here, so
 * rasterization stays off the UI thread. One worker instance serves one
 * document; the main-thread adapter terminates it on close, freeing the
 * whole WASM heap.
 *
 * Protocol is `{ id, method, params }` in and `{ id, ok, result | error }`
 * out, driven by the shared `WorkerClient`.
 * `open` accepts either transferred bytes or a `bookUrl`
 * (`tuxbooks://book/<id>`), which opens through `FPDF_LoadCustomDocument`
 * with an `FPDF_FILEACCESS` range callback, so a document opens (and page 1
 * renders) long before the whole file crosses the bridge.
 *
 * The engine lives in `pdfiumCore.ts` (the only module importing the
 * `@embedpdf/pdfium` package); this file is transport only.
 */

import type { WorkerDiag } from "./pdfWorkerClient";
import type { EngineTextLine } from "./pdfEngineTypes";
import type { RawPdfOutline } from "./pdfOutline";
import { PdfRangeSource } from "./pdfRangeSource";
import { PdfiumEngine, clampBitmapSize, type PageClip } from "./pdfiumCore";
import { isTrustedWorkerOrigin } from "./pdfWorkerOrigin";
import type { FpdfColorScheme } from "./smartColors";

type WorkerRequest =
  | { id: number; method: "prewarm"; params: { wasmUrl: string } }
  | {
      id: number;
      method: "open";
      params: {
        wasmUrl: string;
        data?: ArrayBuffer;
        offset?: number;
        length?: number;
        bookUrl?: string;
      };
    }
  | { id: number; method: "pageSize"; params: { page: number } }
  | { id: number; method: "text"; params: { page: number } }
  | { id: number; method: "outline"; params?: undefined }
  | {
      id: number;
      method: "render";
      params: {
        page: number;
        width: number;
        height: number;
        clip?: PageClip;
        colorScheme?: FpdfColorScheme;
      };
    };

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

let engine: PdfiumEngine | null = null;

/** Post one diagnostic; never throws (the worker may be tearing down). */
function postDiag(diag: WorkerDiag): void {
  try {
    (self as unknown as Worker).postMessage(diag);
  } catch {
    // Structured-clone failure or a closing worker: diagnostics are optional.
  }
}

function heapBytes(): number {
  return engine?.heapBytes() ?? 0;
}

async function ensureEngine(wasmUrl: string): Promise<PdfiumEngine> {
  if (!engine) engine = await PdfiumEngine.load({ wasmUrl });
  return engine;
}

const methods = {
  async prewarm({ wasmUrl }: { wasmUrl: string }): Promise<{ ready: boolean }> {
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
    const loaded = await ensureEngine(params.wasmUrl);
    if (params.bookUrl !== undefined) {
      return { pageCount: loaded.openRange(new PdfRangeSource(params.bookUrl)) };
    }
    const data = params.data;
    if (data === undefined) throw new Error("open requires data or bookUrl");
    const offset = params.offset ?? 0;
    const length = params.length ?? data.byteLength - offset;
    return { pageCount: loaded.openBytes(data, offset, length) };
  },

  pageSize({ page }: { page: number }): { width: number; height: number } {
    if (!engine) throw new Error("no document open");
    const size = engine.pageSize(page - 1);
    if (!size) throw new Error(`page ${page} has no size`);
    return size;
  },

  text({ page }: { page: number }): { lines: EngineTextLine[] } {
    if (!engine) throw new Error("no document open");
    return { lines: engine.textLines(page - 1) };
  },

  outline(): { items: RawPdfOutline[] | null } {
    if (!engine) throw new Error("no document open");
    return { items: engine.outline() };
  },

  async render({
    page,
    width,
    height,
    clip,
    colorScheme,
  }: {
    page: number;
    width: number;
    height: number;
    clip?: PageClip;
    colorScheme?: FpdfColorScheme;
  }): Promise<{ width: number; height: number; bitmap: ImageBitmap }> {
    if (!engine) throw new Error("no document open");
    // The engine caps oversized bitmaps to the WASM heap budget. Clamp here
    // first so the ImageData is built at the size the engine actually renders;
    // constructing it at the requested size throws when the cap bites (a
    // whole-page request rounding just past 2**25 at deep zoom).
    const capped = clampBitmapSize(width, height);
    const rgba = engine.renderRgba(page - 1, capped.width, capped.height, clip, colorScheme);
    const imageData = new ImageData(rgba, capped.width, capped.height);
    const bitmap = await createImageBitmap(imageData);
    return { width: capped.width, height: capped.height, bitmap };
  },
};

// Dedicated workers only receive messages from the document that created
// them, and the dispatch below validates the method and id, but verify the
// sender's origin anyway. The bundle is served from a real origin
// (`app://bundle` in production, the Vite origin in development), so a message
// from anywhere else is rejected rather than trusted.
const SENDER_ORIGIN = self.location.origin;
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (!isTrustedWorkerOrigin(event.origin, SENDER_ORIGIN)) return;
  const request = event.data;
  const respond = (response: WorkerResponse, transfer: Transferable[] = []): void => {
    (self as unknown as Worker).postMessage(response, transfer);
  };
  const page = (request.params as { page?: number } | undefined)?.page;
  const startedAt = performance.now();
  postDiag({
    kind: "pdf-worker-diag",
    phase: "begin",
    method: request.method,
    requestId: request.id,
    page,
    heapBytes: heapBytes(),
  });
  try {
    const method = methods[request.method as keyof typeof methods];
    if (!method) throw new Error(`unknown method ${request.method}`);
    const params = request.params as never;
    const result = (await (method as (p: never) => unknown)(params)) as { bitmap?: ImageBitmap };
    postDiag({
      kind: "pdf-worker-diag",
      phase: "end",
      method: request.method,
      requestId: request.id,
      page,
      ms: performance.now() - startedAt,
      heapBytes: heapBytes(),
    });
    if (result?.bitmap instanceof ImageBitmap) {
      respond({ id: request.id, ok: true, result }, [result.bitmap]);
      return;
    }
    respond({ id: request.id, ok: true, result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    postDiag({
      kind: "pdf-worker-diag",
      phase: "error",
      method: request.method,
      requestId: request.id,
      page,
      ms: performance.now() - startedAt,
      heapBytes: heapBytes(),
      message,
    });
    respond({ id: request.id, ok: false, error: message });
  }
};

// A worker that dies to an uncaught error reports the operation in flight (and
// the heap state) before the engine's request rejection surfaces.
self.addEventListener("unhandledrejection", (event) => {
  postDiag({
    kind: "pdf-worker-diag",
    phase: "unhandled",
    method: "unhandledrejection",
    requestId: 0,
    heapBytes: heapBytes(),
    message: event.reason instanceof Error ? event.reason.message : String(event.reason),
  });
});
self.addEventListener("error", (event) => {
  postDiag({
    kind: "pdf-worker-diag",
    phase: "unhandled",
    method: "error",
    requestId: 0,
    heapBytes: heapBytes(),
    message: event.message,
  });
});
