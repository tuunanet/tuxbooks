import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { PdfRangeSource } from "./pdfRangeSource";

/**
 * PDFium-WASM operations (ADR 0002), independent of the worker transport so
 * the same code backs the worker and the Node integration test. This is the
 * only runtime module that imports the `@embedpdf/pdfium` package; the
 * main-thread adapter imports the worker URL only.
 *
 * PDFium's public API is synchronous C functions that take no native object
 * into a JS callback, so the whole engine runs on the calling thread (the
 * worker) and the MuPDF guardrail class cannot exist here.
 */

/** Subset of the wrapped Emscripten runtime this adapter uses. */
interface PdfiumRuntime {
  HEAPU8: Uint8Array;
  wasmExports: { malloc(size: number): number; free(pointer: number): void };
  addFunction(fn: (...args: number[]) => number, signature: string): number;
  removeFunction(pointer: number): void;
}

export interface PdfiumLoadOptions {
  /** Pre-read WASM binary (Node integration test). */
  wasmBinary?: ArrayBuffer;
  /** URL the browser worker streams the WASM from. */
  wasmUrl?: string;
}

export interface PdfSize {
  width: number;
  height: number;
}

export class PdfiumEngine {
  private doc: number | null = null;
  /** Retained WASM-heap copy for an in-memory open; PDFium borrows it. */
  private memoryPointer: number | null = null;
  private fileAccess: { pointer: number; getBlock: number } | null = null;

  private constructor(private readonly mod: WrappedPdfiumModule) {}

  static async load(options: PdfiumLoadOptions): Promise<PdfiumEngine> {
    if (options.wasmBinary === undefined && options.wasmUrl === undefined) {
      throw new Error("PDFium: load needs wasmBinary or wasmUrl");
    }
    const overrides =
      options.wasmBinary !== undefined
        ? { wasmBinary: options.wasmBinary }
        : { locateFile: (path: string) => (path.endsWith(".wasm") ? options.wasmUrl! : path) };
    const mod = await init(overrides);
    mod.FPDF_InitLibrary();
    mod.PDFiumExt_Init();
    return new PdfiumEngine(mod);
  }

  private get rt(): PdfiumRuntime {
    return this.mod.pdfium as unknown as PdfiumRuntime;
  }

  /** Linear-memory size, the worker's leak/stall breadcrumb. */
  heapBytes(): number {
    return this.rt.HEAPU8.buffer.byteLength;
  }

  /** Opens bytes already resident in the worker; returns the page count. */
  openBytes(data: ArrayBuffer, offset = 0, length = data.byteLength - offset): number {
    this.closeDocument();
    const pointer = this.rt.wasmExports.malloc(length);
    if (!pointer) throw new Error("PDFium: out of memory for document bytes");
    this.rt.HEAPU8.set(new Uint8Array(data, offset, length), pointer);
    this.memoryPointer = pointer;
    const doc = this.mod.FPDF_LoadMemDocument(pointer, length, "");
    if (!doc) {
      this.rt.wasmExports.free(pointer);
      this.memoryPointer = null;
      throw new Error(`PDFium: failed to open document (error ${this.mod.FPDF_GetLastError()})`);
    }
    this.doc = doc;
    return this.mod.FPDF_GetPageCount(doc);
  }

  /**
   * Opens a document through `FPDF_LoadCustomDocument` with an
   * `FPDF_FILEACCESS` whose `m_GetBlock` reads the range source; the whole
   * file never crosses the bridge.
   */
  openRange(source: PdfRangeSource): number {
    this.closeDocument();
    const length = source.fileSize();
    const getBlock = this.rt.addFunction((_param, position, buffer, size) => {
      return source.read(this.rt.HEAPU8, buffer, size, position);
    }, "iiiii");
    const pointer = this.rt.wasmExports.malloc(12);
    const view = new DataView(this.rt.HEAPU8.buffer);
    view.setUint32(pointer + 0, length, true);
    view.setUint32(pointer + 4, getBlock, true);
    view.setUint32(pointer + 8, 0, true);
    this.fileAccess = { pointer, getBlock };
    const doc = this.mod.FPDF_LoadCustomDocument(pointer, "");
    if (!doc) {
      this.freeFileAccess();
      throw new Error(`PDFium: failed to open document (error ${this.mod.FPDF_GetLastError()})`);
    }
    this.doc = doc;
    return this.mod.FPDF_GetPageCount(doc);
  }

  /** Page dimensions in points (0-based index), or null when unavailable. */
  pageSize(index: number): PdfSize | null {
    const doc = this.requireDoc();
    const out = this.rt.wasmExports.malloc(8);
    try {
      if (!this.mod.FPDF_GetPageSizeByIndexF(doc, index, out)) return null;
      const values = new Float32Array(this.rt.HEAPU8.buffer, out, 2);
      return { width: values[0]!, height: values[1]! };
    } finally {
      this.rt.wasmExports.free(out);
    }
  }

  /**
   * Rasterizes one whole page into `width × height` device pixels and
   * returns an RGBA buffer (PDFium's device bitmaps are BGRA). The caller
   * wraps it in an `ImageBitmap` off the main thread.
   */
  renderRgba(index: number, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
    const doc = this.requireDoc();
    const page = this.mod.FPDF_LoadPage(doc, index);
    if (!page) throw new Error(`PDFium: FPDF_LoadPage(${index}) failed`);
    const bitmap = this.mod.FPDFBitmap_Create(width, height, 1);
    if (!bitmap) {
      this.mod.FPDF_ClosePage(page);
      throw new Error(`PDFium: FPDFBitmap_Create(${width}×${height}) failed`);
    }
    try {
      // PDFs paint no page background; viewers supply white.
      this.mod.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
      this.mod.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0);
      const buffer = this.mod.FPDFBitmap_GetBuffer(bitmap);
      const stride = this.mod.FPDFBitmap_GetStride(bitmap);
      const heap = this.rt.HEAPU8;
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        let source = buffer + y * stride;
        let target = y * width * 4;
        for (let x = 0; x < width; x += 1) {
          rgba[target] = heap[source + 2]!;
          rgba[target + 1] = heap[source + 1]!;
          rgba[target + 2] = heap[source]!;
          rgba[target + 3] = heap[source + 3]!;
          source += 4;
          target += 4;
        }
      }
      return rgba;
    } finally {
      this.mod.FPDFBitmap_Destroy(bitmap);
      this.mod.FPDF_ClosePage(page);
    }
  }

  /** Closes the document and releases its bytes, keeping the library loaded. */
  closeDocument(): void {
    if (this.doc !== null) {
      this.mod.FPDF_CloseDocument(this.doc);
      this.doc = null;
    }
    if (this.memoryPointer !== null) {
      this.rt.wasmExports.free(this.memoryPointer);
      this.memoryPointer = null;
    }
    this.freeFileAccess();
  }

  /** Closes the document and destroys the PDFium library. */
  destroy(): void {
    this.closeDocument();
    this.mod.FPDF_DestroyLibrary();
  }

  private freeFileAccess(): void {
    if (this.fileAccess === null) return;
    this.rt.removeFunction(this.fileAccess.getBlock);
    this.rt.wasmExports.free(this.fileAccess.pointer);
    this.fileAccess = null;
  }

  private requireDoc(): number {
    if (this.doc === null) throw new Error("PDFium: no document open");
    return this.doc;
  }
}
