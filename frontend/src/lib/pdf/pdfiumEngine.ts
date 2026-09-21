import workerUrl from "./pdfiumWorker?worker&url";
import wasmUrlRaw from "virtual:pdfium-wasm-url";
import type { PageClip } from "./pdfiumCore";
import type { EngineTextLine, PdfDocument, PdfPage, PdfRenderTask } from "./pdfEngineTypes";
import type { RawPdfOutline } from "./pdfOutline";
import { WorkerClient } from "./pdfWorkerClient";
import { colorSchemeFromPalette, type SmartPalette } from "./smartColors";
import type { BookFormat } from "@/types/domain";

/**
 * Main-thread PDFium adapter (ADR 0002). Implements the `PdfDocument`/
 * `PdfPage` seam and talks to `pdfiumWorker.ts`, which owns the WASM engine.
 * Only this module's worker imports the `@embedpdf/pdfium` package, so no
 * reader component touches an engine.
 *
 * Open, page sizes, whole-page raster, range-backed open (`tuxbooks-koe.5`),
 * viewport-clipped region render at device resolution (`tuxbooks-koe.6`),
 * structured-text lines for the text layer, selection, and in-book search
 * (`tuxbooks-koe.7`), the document outline (`tuxbooks-koe.8`), and the dark
 * colour scheme (`tuxbooks-koe.9`). The seam's `smartColors` palette is mapped
 * onto PDFium's `FPDF_COLORSCHEME` (`colorSchemeFromPalette`), which recolors
 * path and text categories while leaving images intact.
 */

/** Configured worker URL; diagnostics for the E2E worker-load assertion. */
export function pdfiumWorkerSrc(): string {
  return workerUrl;
}

/**
 * Absolute URL of the PDFium WASM bundle. The worker cannot resolve the
 * bundler-relative asset itself, so the main thread resolves the emitted URL
 * against the document location and passes it into the request.
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
  private readonly textLines = new Map<number, Promise<EngineTextLine[]>>();
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
      render: (options) => this.renderPage(pageNumber, size, options),
    };
  }

  private renderPage(
    pageNumber: number,
    size: { width: number; height: number },
    options: {
      canvas: HTMLCanvasElement;
      viewport: { width: number; height: number };
      transform?: number[];
      smartColors?: SmartPalette;
      region?: { x: number; y: number; width: number; height: number };
    },
  ): PdfRenderTask {
    this.assertAlive();
    const ratio = options.transform ? (options.transform[0] ?? 1) : 1;
    let width: number;
    let height: number;
    let clip: PageClip | undefined;
    if (options.region) {
      // Region mode: the caller's canvas is region-sized. The viewport is the
      // full page's CSS size, so CSS pixels convert to page units through the
      // page-units-per-CSS ratio.
      width = Math.max(1, Math.round(options.region.width * ratio));
      height = Math.max(1, Math.round(options.region.height * ratio));
      const pageUnitsPerCss =
        size.width > 0 && options.viewport.width > 0 ? size.width / options.viewport.width : 1;
      clip = [
        options.region.x * pageUnitsPerCss,
        options.region.y * pageUnitsPerCss,
        options.region.width * pageUnitsPerCss,
        options.region.height * pageUnitsPerCss,
      ];
    } else {
      width = Math.max(1, Math.floor(options.viewport.width * ratio));
      height = Math.max(1, Math.floor(options.viewport.height * ratio));
    }
    // The seam hands the dark palette across; PDFium's category colour
    // scheme is derived here so the worker payload carries plain 32-bit
    // colours.
    const colorScheme = options.smartColors
      ? colorSchemeFromPalette(options.smartColors)
      : undefined;
    const handle = this.client.requestCancellable("render", {
      page: pageNumber,
      width,
      height,
      clip,
      colorScheme,
    });
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

  /**
   * The document outline as the seam's raw tree (0-based pages, external links
   * without a page); the worker walks PDFium's bookmarks. The reader tolerates
   * null: documents without an outline simply show none.
   */
  async getOutline(): Promise<RawPdfOutline[] | null> {
    this.assertAlive();
    const { items } = (await this.client.request("outline", undefined)) as {
      items: RawPdfOutline[] | null;
    };
    return items;
  }

  /**
   * Structured-text lines for the page, in page units. Cached per page for the
   * document's lifetime (the text layer and in-book search both read it); a
   * failed extraction is dropped so a retry is not poisoned.
   */
  getTextLines(pageNumber: number): Promise<EngineTextLine[]> {
    this.assertAlive();
    let lines = this.textLines.get(pageNumber);
    if (!lines) {
      lines = this.client
        .request("text", { page: pageNumber })
        .then((raw) => (raw as { lines: EngineTextLine[] }).lines);
      this.textLines.set(pageNumber, lines);
      lines.catch(() => this.textLines.delete(pageNumber));
    }
    return lines;
  }

  onWorkerFailed(callback: () => void): () => void {
    return this.client.onFailed(callback);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pageSizes.clear();
    this.textLines.clear();
    this.client.terminate();
  }
}

/** Prewarmed PDFium worker: one idle worker holds the loaded WASM module. */
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
