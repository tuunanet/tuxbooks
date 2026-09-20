import workerUrl from "./mupdfWorker?worker&url";
import wasmUrlRaw from "virtual:mupdf-wasm-url";
import { normalizePdfOutline, type PdfOutlineItem, type RawPdfOutline } from "./pdfOutline";
import { assemblePageText, type PdfTextItem } from "./pdfSearch";
import { selectPdfEngine } from "./pdfEngineFlag";
import { PdfRenderCancelledError, isRenderingCancelled } from "./pdfEngineTypes";
import type { EngineTextLine, PdfDocument, PdfPage } from "./pdfEngineTypes";
import { WorkerClient } from "./pdfWorkerClient";
import {
  cancelPdfiumPrewarm,
  openPdfiumDocument,
  openPdfiumDocumentFromBook,
  pdfiumWorkerSrc,
  prewarmPdfiumEngine,
} from "./pdfiumEngine";
import type { SmartPalette } from "./smartColors";
import type { BookFormat } from "@/types/domain";

export { PdfRenderCancelledError, isRenderingCancelled } from "./pdfEngineTypes";
export type { EngineTextLine, PdfDocument, PdfPage, PdfRenderTask } from "./pdfEngineTypes";

/**
 * The single seam between the app and the PDF engine. Components depend on
 * these re-exported types and helpers only, never on an engine package, so
 * the engine stays swappable and unit tests can mock one module.
 *
 * The feature flag (`pdfEngineFlag.selectPdfEngine`, ADR 0002) picks the
 * implementation at the open/prewarm/worker-URL functions below: MuPDF is
 * the default, PDFium is opt-in (tuxbooks-koe.5). The type contract and the
 * pure helpers are shared, so no reader component changes when the engine
 * swaps. Each engine rasterizes synchronously, so both live in a dedicated
 * module worker (`mupdfWorker.ts`, `pdfiumWorker.ts`): one worker per
 * document, terminated on close, with the WASM bundle kept out of the entry
 * chunk.
 *
 * Page geometry is in PDF page units (points) at scale 1: `getViewport({
 * scale })` returns CSS pixels, renders address the backing store through
 * the transform ratio.
 */

/**
 * Smart Dark drives each page through the engine's JS callback Device, and
 * that path corrupts MuPDF's internal state after enough renders on some
 * documents (the WASM heap stays flat once the device objects are released,
 * but shading-heavy pages start throwing `Unexpected mesh type` and then
 * `exception stack overflow`). Bound the damage: after this many Smart Dark
 * renders the document trades its worker for a fresh one, which reopens from
 * the range-backed source with an empty WASM heap and clean MuPDF state.
 */
const SMART_RENDER_RECYCLE_LIMIT = 180;
/** Grace for the old worker's in-flight requests before its teardown. */
const RECYCLE_DRAIN_GRACE_MS = 2_000;

/** Open request retained by a range-backed document for worker recycling. */
interface WorkerOpenRequest {
  wasmUrl: string;
  bookUrl: string;
}

/**
 * Configured worker URL for the active engine; diagnostics for the E2E
 * worker-load assertion.
 */
export function pdfWorkerSrc(): string {
  return selectPdfEngine() === "pdfium" ? pdfiumWorkerSrc() : workerUrl;
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

class MuPdfDocument implements PdfDocument {
  readonly numPages: number;
  private client: WorkerClient;
  private readonly pageSizes = new Map<number, { width: number; height: number }>();
  private readonly textLines = new Map<number, Promise<EngineTextLine[]>>();
  private readonly reopen: WorkerOpenRequest | null;
  private smartRenders = 0;
  private recycling = false;
  private draining: WorkerClient | null = null;
  /** Resolves when a forced recycle has swapped in the replacement worker. */
  private recyclePromise: Promise<void> | null = null;
  /**
   * Whether a failure-escape is armed for the current worker. A Smart Dark
   * render that THREW means the worker's MuPDF state is suspect (shading
   * pages corrupt the wasm heap through the recolor device — GeoTopo page
   * 35), so the first throw swaps the worker; the escape re-arms only after
   * a successful Smart Dark render. A second failure before any success is
   * a content incompatibility: swapping per attempt would storm the worker
   * on every zoom commit that clears the page's failed flag.
   */
  private escapedOnSmartFailure = false;
  private destroyed = false;

  constructor(client: WorkerClient, numPages: number, reopen: WorkerOpenRequest | null = null) {
    this.client = client;
    this.numPages = numPages;
    this.reopen = reopen;
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
      render: ({ canvas, viewport, transform, smartColors, region }) =>
        this.renderPage(pageNumber, size, canvas, viewport, transform, smartColors, region),
    };
  }

  private renderPage(
    pageNumber: number,
    size: { width: number; height: number },
    canvas: HTMLCanvasElement,
    viewport: { width: number; height: number },
    transform: number[] | undefined,
    smartColors: SmartPalette | undefined,
    region: { x: number; y: number; width: number; height: number } | undefined,
  ): { promise: Promise<void>; cancel(): void } {
    const ratio = transform ? (transform[0] ?? 1) : 1;
    let width: number;
    let height: number;
    let clip: [number, number, number, number] | undefined;
    if (region) {
      width = Math.max(1, Math.round(region.width * ratio));
      height = Math.max(1, Math.round(region.height * ratio));
      // The viewport is the full page's CSS size, so CSS pixels convert to
      // page units by the page-units-per-CSS ratio.
      const pageUnitsPerCss =
        size.width > 0 && viewport.width > 0 ? size.width / viewport.width : 1;
      clip = [
        region.x * pageUnitsPerCss,
        region.y * pageUnitsPerCss,
        region.width * pageUnitsPerCss,
        region.height * pageUnitsPerCss,
      ];
    } else {
      width = Math.floor(viewport.width * ratio);
      height = Math.floor(viewport.height * ratio);
    }
    const start = (): { result: Promise<unknown>; cancel: () => void } => {
      const handle = this.client.requestCancellable("render", {
        page: pageNumber,
        width,
        height,
        smart: smartColors,
        clip,
      });
      return handle as { result: Promise<unknown>; cancel: () => void };
    };
    // Hold new rasters while a worker replacement is in flight: the previous
    // worker can be left in a corrupted state by a fallback Smart Dark
    // render, and sending it another raster crashes the renderer.
    let cancelled = false;
    let cancelRequest: (() => void) | null = null;
    const begin = (): Promise<unknown> => {
      if (cancelled) return Promise.reject(new PdfRenderCancelledError());
      const handle = start();
      cancelRequest = handle.cancel;
      return handle.result;
    };
    const result = this.recyclePromise ? this.recyclePromise.then(begin) : begin();
    const promise = result
      .then((raw) => {
        const { bitmap, recovered } = raw as { bitmap: ImageBitmap; recovered?: boolean };
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context is unavailable");
        try {
          // The worker normally returns a bitmap at the canvas's exact backing
          // size. The whole-page fallback for unlistable pages returns a
          // smaller crop (its raster is pixel-capped to protect the wasm heap),
          // so stretch to the backing store rather than blitting 1:1.
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        } finally {
          bitmap.close();
        }
        if (smartColors) {
          this.smartRenders += 1;
          // A clean render proves this worker is healthy again: re-arm the
          // failure escape.
          this.escapedOnSmartFailure = false;
          // A page that had to bypass the display list also bypasses the
          // recoloring device's normal path and has been observed to corrupt
          // MuPDF state (renderer crash a raster later). Escape that worker
          // immediately instead of waiting for the render budget.
          if (recovered) this.forceRecycle();
          else this.maybeRecycle();
        }
      })
      .catch((error: unknown) => {
        // A Smart Dark render that THREW is the same corruption signal as a
        // bypass, just further along: shading pages damage the worker's wasm
        // heap through the recolor device, and every raster after the throw
        // runs on the damaged heap. Escape this worker on the first failure
        // so the page's next attempt (Retry, the next zoom/scroll commit)
        // lands on a fresh one; a second failure before any success is a
        // content incompatibility, and swapping per attempt would storm the
        // worker on every zoom commit that clears the page's failed flag.
        // Cancellations are the reader superseding its own renders — not a
        // worker-health signal.
        if (smartColors && !isRenderingCancelled(error) && !this.escapedOnSmartFailure) {
          this.escapedOnSmartFailure = true;
          this.forceRecycle();
        }
        throw error;
      });
    return {
      promise,
      cancel: () => {
        cancelled = true;
        cancelRequest?.();
      },
    };
  }

  /**
   * Replace the worker as soon as a Smart Dark render took the display-list
   * fallback. Those pages corrupt the worker's MuPDF state, and the next
   * raster on it crashes the renderer; a fresh worker escapes that. Renders
   * started meanwhile wait for the swap (`recyclePromise`), so the corrupted
   * worker never serves another raster.
   */
  private forceRecycle(): void {
    if (!this.reopen || this.destroyed || this.recycling) return;
    this.recycling = true;
    this.recyclePromise = new Promise<void>((resolve) => {
      // Forced recycles happen after the offending render finished, so the
      // old worker has no in-flight work: terminate it at the swap instead of
      // waiting out the graceful drain.
      void this.recycleWorker(resolve, false);
    }).finally(() => {
      this.recyclePromise = null;
    });
  }

  /**
   * Recycle the worker once Smart Dark has rendered enough pages to risk
   * MuPDF state corruption (see `SMART_RENDER_RECYCLE_LIMIT`). The
   * replacement opens the same range-backed source and takes over new work;
   * the old worker drains its queue first, so no in-flight render is lost.
   */
  private maybeRecycle(): void {
    if (!this.reopen || this.destroyed || this.recycling) return;
    if (this.smartRenders < SMART_RENDER_RECYCLE_LIMIT) return;
    this.recycling = true;
    void this.recycleWorker();
  }

  private async recycleWorker(onSwapped?: () => void, drainGraceful = true): Promise<void> {
    const reopen = this.reopen;
    if (!reopen) {
      this.recycling = false;
      return;
    }
    const replacement = new WorkerClient(workerUrl, "MuPDF");
    try {
      await replacement.request("open", reopen);
      if (this.destroyed) {
        replacement.terminate();
        return;
      }
      const previous = this.client;
      this.client = replacement;
      this.smartRenders = 0;
      this.draining = previous;
      console.info("[pdf-engine] recycled MuPDF worker after Smart Dark render budget");
      // New work may go to the replacement immediately; the gate on
      // `recyclePromise` opens here, not after the old worker drains.
      onSwapped?.();
      if (drainGraceful) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RECYCLE_DRAIN_GRACE_MS);
          void previous.whenIdle().then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      } else {
        previous.terminate();
        this.draining = null;
      }
    } catch (error: unknown) {
      replacement.terminate();
      // Keep the current worker; reset the budget so the next batch retries
      // instead of spinning on a failing reopen.
      this.smartRenders = 0;
      console.warn(
        `[pdf-engine] worker recycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // Always open the render gate, whether the swap happened, the reopen
      // failed, or the document was destroyed mid-recycle.
      onSwapped?.();
      this.draining?.terminate();
      this.draining = null;
      this.recycling = false;
    }
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
    this.draining?.terminate();
    this.draining = null;
  }
}

/**
 * Prewarmed worker state: at most one idle engine worker holds a loaded
 * MuPDF/WASM module. The first document open adopts it instead of paying
 * worker startup + module load + WASM fetch/compile on the open critical
 * path. The prewarm never opens a document or rasterizes anything.
 */
let prewarmedClient: WorkerClient | null = null;
let prewarmPromise: Promise<void> | null = null;

/**
 * Load the MuPDF module into a spare worker ahead of any document open.
 * Safe to call repeatedly (single-flight); never throws into app startup —
 * a failed prewarm just discards the spare worker, and the next open pays
 * the cold start instead. Runs without opening a document or rasterizing.
 */
export function prewarmMuPdfEngine(): Promise<void> {
  if (prewarmPromise) return prewarmPromise;
  if (typeof Worker === "undefined") {
    // Non-worker hosts (unit tests, exotic embeddings): nothing to warm.
    return Promise.resolve();
  }
  const client = new WorkerClient(workerUrl, "MuPDF");
  prewarmedClient = client;
  prewarmPromise = client
    .request("prewarm", { wasmUrl: resolveWasmUrl() })
    .then(() => undefined)
    .catch((error: unknown) => {
      // Discard only if still the current spare; an adopted worker is owned
      // by its document and must not be terminated here.
      if (prewarmedClient === client) {
        client.terminate();
        prewarmedClient = null;
        prewarmPromise = null;
      }
      throw error;
    });
  return prewarmPromise;
}

/**
 * Cancel an in-flight prewarm that was never adopted (reader closed before
 * any open, test teardown). Terminating a spare worker is free; a worker
 * already adopted by a document is left alone.
 */
export function cancelPdfPrewarm(): void {
  if (prewarmedClient) {
    prewarmedClient.terminate();
    prewarmedClient = null;
  }
  prewarmPromise = null;
  cancelPdfiumPrewarm();
}

/** Hand the spare worker to a document open, if one is warm. */
function takePrewarmedClient(): WorkerClient | null {
  const client = prewarmedClient;
  prewarmedClient = null;
  prewarmPromise = null;
  return client;
}

/**
 * Open a PDF from in-memory bytes through the MuPDF engine. The underlying
 * buffer is transferred to the document's worker, so callers must not reuse
 * the array afterwards.
 */
export async function openMuPdfDocument(data: Uint8Array): Promise<PdfDocument> {
  const client = takePrewarmedClient() ?? new WorkerClient(workerUrl, "MuPDF");
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

/**
 * Open a stored book's PDF without ever loading the whole file into the
 * renderer: the worker opens the document through a random-access stream
 * over `tuxbooks://book/<id>`, and MuPDF pulls only the ranges it needs
 * (xref trail, then page 1 content) — the full-file transfer leaves the
 * first-page critical path entirely.
 */
export async function openMuPdfDocumentFromBook(
  bookId: number,
  format: BookFormat,
): Promise<PdfDocument> {
  const client = takePrewarmedClient() ?? new WorkerClient(workerUrl, "MuPDF");
  const reopen: WorkerOpenRequest = {
    wasmUrl: resolveWasmUrl(),
    bookUrl: `tuxbooks://book/${bookId}?format=${format}`,
  };
  try {
    const { pageCount } = (await client.request("open", reopen)) as { pageCount: number };
    return new MuPdfDocument(client, pageCount, reopen);
  } catch (error: unknown) {
    client.terminate();
    throw error;
  }
}

/**
 * Engine selection point (ADR 0002). The feature flag picks MuPDF or PDFium
 * here, so no reader component changes when the engine swaps. MuPDF is the
 * default until the flip ticket.
 */
export function prewarmPdfEngine(): Promise<void> {
  return selectPdfEngine() === "pdfium" ? prewarmPdfiumEngine() : prewarmMuPdfEngine();
}

/**
 * Open a PDF from in-memory bytes through the selected engine. The underlying
 * buffer is transferred to the document's worker, so callers must not reuse
 * the array afterwards.
 */
export function openPdfDocument(data: Uint8Array): Promise<PdfDocument> {
  return selectPdfEngine() === "pdfium" ? openPdfiumDocument(data) : openMuPdfDocument(data);
}

/**
 * Open a stored book's PDF without ever loading the whole file into the
 * renderer: the worker opens the document through a random-access stream
 * over `tuxbooks://book/<id>` and pulls only the ranges it needs (xref
 * trail, then page 1 content), so the full-file transfer leaves the
 * first-page critical path entirely.
 */
export function openPdfDocumentFromBook(bookId: number, format: BookFormat): Promise<PdfDocument> {
  return selectPdfEngine() === "pdfium"
    ? openPdfiumDocumentFromBook(bookId, format)
    : openMuPdfDocumentFromBook(bookId, format);
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

/** Smart Dark recoloring palette (issue #67), re-exported through the seam. */
export type { SmartPalette } from "./smartColors";

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
