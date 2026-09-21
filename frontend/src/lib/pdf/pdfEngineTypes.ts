import type { RawPdfOutline } from "./pdfOutline";
import type { SmartPalette } from "./smartColors";

/**
 * The engine seam's types (ADR 0002). The PDFium adapter implements
 * `PdfDocument`/`PdfPage`; components depend on these and the re-exports in
 * `pdfEngine.ts`, never on an engine package.
 */

/** One structured-text line in page units (points); `y` is the baseline. */
export interface EngineTextLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
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
   *
   * `smartColors` turns on the dark colour scheme in the worker (ADR 0002):
   * PDFium recolors path and text categories onto the dark palette while
   * images keep their pixels. Undefined renders the page as-is (Original,
   * and every filter/tint-based theme — those are applied as CSS over the
   * surface, never at raster time).
   */
  render(options: {
    canvas: HTMLCanvasElement;
    viewport: { width: number; height: number };
    transform?: number[];
    smartColors?: SmartPalette;
    /**
     * Viewport-clipped region render: the visible part of the page in CSS
     * pixels relative to the page's top-left, with `viewport` still the full
     * page's CSS size (so page units can be recovered). The returned bitmap
     * and the caller's canvas are region-sized. Absent renders the whole
     * page.
     */
    region?: { x: number; y: number; width: number; height: number };
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
  /**
   * Registers a one-shot listener for unexpected worker death (not
   * cancellation, not close): the document owner uses it to re-open the
   * document from its range-backed source. Optional so test fakes can
   * omit it.
   */
  onWorkerFailed?(callback: () => void): () => void;
  /** Terminates the document's worker, freeing all WASM resources. */
  destroy(): Promise<void>;
}
