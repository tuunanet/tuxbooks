import workerUrl from "./mupdfWorker?worker&url";
import wasmUrlRaw from "virtual:mupdf-wasm-url";
import { normalizePdfOutline, type PdfOutlineItem, type RawPdfOutline } from "./pdfOutline";
import { assemblePageText, type PdfTextItem } from "./pdfSearch";

/**
 * The single seam between the app and the MuPDF.js/WASM engine. Components
 * depend on these re-exported types and helpers only, never on mupdf
 * directly, so the engine stays swappable and unit tests can mock one
 * module.
 *
 * MuPDF rasterizes synchronously, so the engine lives in a dedicated module
 * worker (`mupdfWorker.ts`): every document gets its own worker instance and
 * closing the document terminates it, freeing the whole WASM heap. The
 * worker loads lazily on the first document open, and the WASM bundle stays
 * out of the entry chunk.
 *
 * Page geometry is in PDF page units (points) at scale 1: `getViewport({
 * scale })` returns CSS pixels, renders address the backing store through
 * the transform ratio.
 */

/** One structured-text line in page units (points); `y` is the baseline. */
interface EngineTextLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Cancellation marker for renders and text-layer builds that were
 * superseded before completion (page left the virtualization window,
 * unmount, book switch). Expected control flow, never an error.
 */
export class PdfRenderCancelledError extends Error {
  constructor() {
    super("PDF render cancelled");
    this.name = "PdfRenderCancelledError";
  }
}

/** True when a failure is a cancellation rather than a real error. */
export function isRenderingCancelled(error: unknown): boolean {
  return error instanceof PdfRenderCancelledError;
}

/** Configured worker URL; diagnostics for the E2E worker-load assertion. */
export function pdfWorkerSrc(): string {
  return workerUrl;
}

/**
 * Absolute URL of the MuPDF WASM bundle, resolved once at first open. The
 * worker cannot resolve the asset itself: bundler-relative URLs inside a
 * worker chunk never point at the emitted file, so the main thread resolves
 * the emitted URL against the document location and passes it into the open
 * request.
 */
function resolveWasmUrl(): string {
  return new URL(wasmUrlRaw, globalThis.location?.href ?? import.meta.url).href;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

class WorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor() {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error ?? "MuPDF worker failure"));
    };
    this.worker.onerror = (event) => {
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const request of pending) {
        request.reject(new Error(event.message || "MuPDF worker failed to load"));
      }
    };
  }

  request(method: string, params: unknown, transfer: Transferable[] = []): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, params }, transfer);
    });
  }

  requestCancellable(
    method: string,
    params: unknown,
  ): { result: Promise<unknown>; cancel: () => void } {
    const id = this.nextId++;
    let cancelled = false;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => {
          if (cancelled) {
            reject(new PdfRenderCancelledError());
            return;
          }
          resolve(value);
        },
        reject: (reason) => {
          reject(cancelled ? new PdfRenderCancelledError() : reason);
        },
      });
      this.worker.postMessage({ id, method, params });
    });
    return {
      result,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.reject(new PdfRenderCancelledError());
        }
      },
    };
  }

  terminate(): void {
    this.worker.terminate();
  }
}

export interface PdfPage {
  /**
   * Page dimensions in CSS pixels at the given scale (the viewport shape
   * the layout math is written against).
   */
  getViewport(options: { scale: number }): { width: number; height: number };
  /**
   * Rasterizes the page into `canvas` (sized by the caller) at the viewport
   * size times the transform ratio. Returns a cancellable promise; a
   * cancelled render rejects with PdfRenderCancelledError and never paints.
   */
  render(options: {
    canvas: HTMLCanvasElement;
    viewport: { width: number; height: number };
    transform?: number[];
  }): { promise: Promise<void>; cancel(): void };
}

/** Handle of an in-flight render; cancellation is expected control flow. */
export type PdfRenderTask = { promise: Promise<void>; cancel(): void };

export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  /** Raw engine outline (0-based pages, external links without a page). */
  getOutline(): Promise<RawPdfOutline[] | null>;
  /** Structured-text lines of one page, in page units. */
  getTextLines(pageNumber: number): Promise<EngineTextLine[]>;
  /** Terminates the document's worker, freeing all WASM resources. */
  destroy(): Promise<void>;
}

class MuPdfDocument implements PdfDocument {
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
      render: ({ canvas, viewport, transform }) =>
        this.renderPage(pageNumber, canvas, viewport, transform),
    };
  }

  private renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    viewport: { width: number; height: number },
    transform: number[] | undefined,
  ): { promise: Promise<void>; cancel(): void } {
    const ratio = transform ? (transform[0] ?? 1) : 1;
    const width = Math.floor(viewport.width * ratio);
    const height = Math.floor(viewport.height * ratio);
    const { result, cancel } = this.client.requestCancellable("render", {
      page: pageNumber,
      width,
      height,
    });
    const promise = result.then((raw) => {
      const { bitmap } = raw as { bitmap: ImageBitmap };
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context is unavailable");
      try {
        context.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
    });
    return { promise, cancel };
  }

  async getOutline(): Promise<RawPdfOutline[] | null> {
    this.assertAlive();
    const { items } = (await this.client.request("outline", undefined)) as {
      items: RawPdfOutline[] | null;
    };
    return items;
  }

  getTextLines(pageNumber: number): Promise<EngineTextLine[]> {
    this.assertAlive();
    let lines = this.textLines.get(pageNumber);
    if (!lines) {
      lines = this.client
        .request("text", { page: pageNumber })
        .then((raw) => (raw as { lines: EngineTextLine[] }).lines);
      this.textLines.set(pageNumber, lines);
      // A failed extraction must not poison the cache for retries.
      lines.catch(() => this.textLines.delete(pageNumber));
    }
    return lines;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.client.terminate();
  }
}

/**
 * Open a PDF from in-memory bytes. The underlying buffer is transferred to
 * the document's worker, so callers must not reuse the array afterwards.
 */
export async function openPdfDocument(data: Uint8Array): Promise<PdfDocument> {
  const client = new WorkerClient();
  try {
    const { pageCount } = (await client.request(
      "open",
      {
        wasmUrl: resolveWasmUrl(),
        data: data.buffer,
        offset: data.byteOffset,
        length: data.byteLength,
      },
      [data.buffer],
    )) as { pageCount: number };
    return new MuPdfDocument(client, pageCount);
  } catch (error: unknown) {
    client.terminate();
    throw error;
  }
}

/** Terminate a document's worker and release every WASM resource. */
export async function closePdfDocument(document: PdfDocument): Promise<void> {
  await document.destroy();
}

/**
 * The document's outline (table of contents) with every destination
 * resolved to a 1-based page. Documents without an outline normalize to an
 * empty list. Normalization lives in pdfOutline.ts (pure, unit-tested
 * without the engine); this re-export keeps components on the seam.
 */
export async function getPdfOutline(document: PdfDocument): Promise<PdfOutlineItem[]> {
  return normalizePdfOutline(await document.getOutline());
}
export type { PdfOutlineItem } from "./pdfOutline";

/**
 * Assembled plain text of one page (structured text lines), for in-book
 * search. Lines are joined at their boundaries so queries match across line
 * breaks like they read in the rendered page. Assembly itself is a pure
 * function in pdfSearch.ts (unit-tested without the engine).
 */
export async function getPdfPageText(document: PdfDocument, pageNumber: number): Promise<string> {
  const lines = await document.getTextLines(pageNumber);
  const items: PdfTextItem[] = lines.map((line) => ({ str: line.text, hasEOL: true }));
  return assemblePageText(items);
}

export { findPageMatches, type PdfSearchExcerpt } from "./pdfSearch";

/**
 * Renders one page's text layer into `container` (positioned over the page
 * canvas by the caller): transparent spans positioned in page-unit space at
 * the given scale, built from the engine's structured-text lines. The layer
 * is what makes PDF text selectable, so highlights can be created from real
 * user selections; it carries no visuals of its own. Failures are
 * non-fatal: a page without a text layer simply cannot be selected.
 */
export async function renderPdfTextLayer(
  document: PdfDocument,
  pageNumber: number,
  container: HTMLElement,
  scale: number,
): Promise<{ cancel(): void }> {
  const lines = await document.getTextLines(pageNumber);
  for (const line of lines) {
    const span = container.ownerDocument.createElement("span");
    span.textContent = line.text;
    span.style.left = `${line.x * scale}px`;
    span.style.top = `${line.y * scale}px`;
    span.style.width = `${Math.max(line.w, 1) * scale}px`;
    span.style.height = `${Math.max(line.h, 1) * scale}px`;
    span.style.fontSize = `${Math.min(line.size, line.h) * scale}px`;
    span.style.lineHeight = `${line.h * scale}px`;
    container.appendChild(span);
  }
  return {
    cancel: () => {
      container.textContent = "";
    },
  };
}
