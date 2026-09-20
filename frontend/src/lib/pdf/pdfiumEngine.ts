import workerUrl from "./pdfiumWorker?worker&url";
import wasmUrlRaw from "virtual:pdfium-wasm-url";
import type { EngineTextLine, PdfDocument, PdfPage, PdfRenderTask } from "./pdfEngineTypes";
import { WorkerClient } from "./pdfWorkerClient";
import type { BookFormat } from "@/types/domain";

/**
 * Main-thread PDFium adapter (ADR 0002). Implements the `PdfDocument`/
 * `PdfPage` seam and talks to `pdfiumWorker.ts`, which owns the WASM engine.
 * Only this module's worker imports the `@embedpdf/pdfium` package, so no
 * reader component touches an engine.
 *
 * Scope of this ticket (`tuxbooks-koe.5`): open, page sizes, whole-page
 * raster, and range-backed open. Region render (`tuxbooks-koe.6`), text
 * (`tuxbooks-koe.7`), outline and search (`tuxbooks-koe.8`), and the dark
 * colour scheme (`tuxbooks-koe.9`) are reserved and fail soft (empty text,
 * no outline, plain raster) so the reader still opens and renders.
 */

/** Configured worker URL; diagnostics for the E2E worker-load assertion. */
export function pdfiumWorkerSrc(): string {
  return workerUrl;
}

/**
 * Absolute URL of the PDFium WASM bundle. Like MuPDF's, the worker cannot
 * resolve the bundler-relative asset itself, so the main thread resolves the
 * emitted URL against the document location and passes it into the request.
 */
function resolvePdfiumWasmUrl(): string {
  return new URL(wasmUrlRaw, globalThis.location?.href ?? import.meta.url).href;
}

interface PdfiumOpenRequest {
  wasmUrl: string;
  bookUrl: string;
}

class PdfiumDocument implements PdfDocument {
  readonly numPages: number;
  private readonly client: WorkerClient;
  private readonly pageSizes = new Map<number, { width: number; height: number }>();
  private destroyed = false;

  constructor(client: WorkerClient, numPages: number) {
    this.client = client;
    this.numPages = numPages;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("PDF document is closed");
  }

  async getPage(pageNumber: number): Promise<PdfPage> {
    this.assertAlive();
    let size = this.pageSizes.get(pageNumber);
    if (!size) {
      size = (await this.client.request("pageSize", { page: pageNumber })) as {
        width: number;
        height: number;
      };
      this.pageSizes.set(pageNumber, size);
    }
    return {
      getViewport: ({ scale }) => ({ width: size.width * scale, height: size.height * scale }),
      render: (options) => this.renderPage(pageNumber, options),
    };
  }

  private renderPage(
    pageNumber: number,
    options: {
      canvas: HTMLCanvasElement;
      viewport: { width: number; height: number };
      transform?: number[];
      smartColors?: unknown;
      region?: { x: number; y: number; width: number; height: number };
    },
  ): PdfRenderTask {
    this.assertAlive();
    // Region render is ticket tuxbooks-koe.6; until then a deep-zoom request
    // must fail loudly rather than paint the wrong pixels.
    if (options.region) {
      return {
        promise: Promise.reject(
          new Error("PDFium region render is not implemented until tuxbooks-koe.6"),
        ),
        cancel: () => {},
      };
    }
    const ratio = options.transform ? (options.transform[0] ?? 1) : 1;
    const width = Math.max(1, Math.floor(options.viewport.width * ratio));
    const height = Math.max(1, Math.floor(options.viewport.height * ratio));
    const handle = this.client.requestCancellable("render", { page: pageNumber, width, height });
    const promise = handle.result.then((raw) => {
      const { bitmap } = raw as { bitmap: ImageBitmap };
      const context = options.canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context is unavailable");
      try {
        context.drawImage(bitmap, 0, 0, options.canvas.width, options.canvas.height);
      } finally {
        bitmap.close();
      }
    });
    return { promise, cancel: handle.cancel };
  }

  /** Reserved for tuxbooks-koe.8; the reader tolerates a missing outline. */
  async getOutline(): Promise<null> {
    this.assertAlive();
    return null;
  }

  /** Reserved for tuxbooks-koe.7; empty lines yield no text layer. */
  async getTextLines(): Promise<EngineTextLine[]> {
    this.assertAlive();
    return [];
  }

  onWorkerFailed(callback: () => void): () => void {
    return this.client.onFailed(callback);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pageSizes.clear();
    this.client.terminate();
  }
}

/** Prewarmed PDFium worker (mirrors the MuPDF prewarm contract). */
let prewarmedClient: WorkerClient | null = null;
let prewarmPromise: Promise<void> | null = null;

export function prewarmPdfiumEngine(): Promise<void> {
  if (prewarmPromise) return prewarmPromise;
  if (typeof Worker === "undefined") return Promise.resolve();
  const client = new WorkerClient(workerUrl, "PDFium");
  prewarmedClient = client;
  prewarmPromise = client
    .request("prewarm", { wasmUrl: resolvePdfiumWasmUrl() })
    .then(() => undefined)
    .catch((error: unknown) => {
      if (prewarmedClient === client) {
        client.terminate();
        prewarmedClient = null;
        prewarmPromise = null;
      }
      throw error;
    });
  return prewarmPromise;
}

export function cancelPdfiumPrewarm(): void {
  if (prewarmedClient) {
    prewarmedClient.terminate();
    prewarmedClient = null;
  }
  prewarmPromise = null;
}

function takePrewarmedClient(): WorkerClient | null {
  const client = prewarmedClient;
  prewarmedClient = null;
  prewarmPromise = null;
  return client;
}

/**
 * Open a PDF from in-memory bytes. The underlying buffer is transferred to
 * the document's worker, so callers must not reuse the array afterwards.
 */
export async function openPdfiumDocument(data: Uint8Array): Promise<PdfDocument> {
  const client = takePrewarmedClient() ?? new WorkerClient(workerUrl, "PDFium");
  try {
    const { pageCount } = (await client.request(
      "open",
      {
        wasmUrl: resolvePdfiumWasmUrl(),
        data: data.buffer,
        offset: data.byteOffset,
        length: data.byteLength,
      },
      [data.buffer],
    )) as { pageCount: number };
    return new PdfiumDocument(client, pageCount);
  } catch (error: unknown) {
    client.terminate();
    throw error;
  }
}

/**
 * Open a stored book's PDF through `FPDF_LoadCustomDocument`, so the worker
 * pulls only the ranges PDFium needs (xref trail, then page 1 content) off
 * `tuxbooks://book/<id>`.
 */
export async function openPdfiumDocumentFromBook(
  bookId: number,
  format: BookFormat,
): Promise<PdfDocument> {
  const client = takePrewarmedClient() ?? new WorkerClient(workerUrl, "PDFium");
  const request: PdfiumOpenRequest = {
    wasmUrl: resolvePdfiumWasmUrl(),
    bookUrl: `tuxbooks://book/${bookId}?format=${format}`,
  };
  try {
    const { pageCount } = (await client.request("open", request)) as { pageCount: number };
    return new PdfiumDocument(client, pageCount);
  } catch (error: unknown) {
    client.terminate();
    throw error;
  }
}
