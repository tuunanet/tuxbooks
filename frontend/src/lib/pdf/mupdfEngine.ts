import workerUrl from "./mupdfWorker?worker&url";
import wasmUrlRaw from "virtual:mupdf-wasm-url";

/**
 * Bundler assets of the MuPDF engine adapter (ADR 0002, tuxbooks-koe.10).
 * The seam (`pdfEngine.ts`) and reader components call these helpers instead
 * of importing the worker module or the virtual WASM URL, so the engine
 * assets stay behind the adapter boundary that the lint rule enforces.
 */

/** Configured MuPDF worker URL; diagnostics for the E2E worker-load assertion. */
export function mupdfWorkerSrc(): string {
  return workerUrl;
}

/**
 * Absolute URL of the MuPDF WASM bundle, resolved once at first open. The
 * worker cannot resolve the asset itself: bundler-relative URLs inside a
 * worker chunk never point at the emitted file, so the main thread resolves
 * the emitted URL against the document location and passes it into the open
 * request.
 */
export function resolveMuPdfWasmUrl(): string {
  return new URL(wasmUrlRaw, globalThis.location?.href ?? import.meta.url).href;
}
