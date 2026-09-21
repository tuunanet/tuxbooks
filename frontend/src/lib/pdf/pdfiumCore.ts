import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { EngineTextLine } from "./pdfEngineTypes";
import type { RawPdfOutline } from "./pdfOutline";
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
  UTF16ToString(pointer: number): string;
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

/** Viewport region in page units: `[left, top, width, height]`. */
export type PageClip = [number, number, number, number];

/** Accumulator for one text line while its characters are walked. */
interface LineBuilder {
  text: string;
  /** Left edge, page units. */
  x: number;
  /** Right edge, page units. */
  right: number;
  /** Top edge (PDF space, y up), page units. */
  top: number;
  /** Bottom edge (PDF space, y up), page units. */
  bottom: number;
  /** Baseline (PDF space, y up), page units. */
  baseline: number;
  size: number;
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
   * Structured-text lines of one page (0-based index), in page units, for the
   * text layer and selection. PDFium exposes per-character boxes rather than
   * lines, so characters are walked in order and grouped by baseline; the
   * loose character box (the font's line box, not just the glyph ink) gives
   * the vertical extents the text-layer renderer expects.
   *
   * Coordinates are returned with a top-left origin, y down, so
   * `renderPdfTextLayer` positions spans unchanged; PDF space is y up, so the
   * vertical values are flipped through the page height. Pages with no text
   * yield an empty list, never an error. Page rotation is not applied.
   */
  textLines(index: number): EngineTextLine[] {
    const size = this.pageSize(index);
    if (!size) return [];
    const page = this.mod.FPDF_LoadPage(this.requireDoc(), index);
    if (!page) return [];
    const textPage = this.mod.FPDFText_LoadPage(page);
    if (!textPage) {
      this.mod.FPDF_ClosePage(page);
      return [];
    }
    const box = this.rt.wasmExports.malloc(16);
    const origin = this.rt.wasmExports.malloc(16);
    try {
      const count = this.mod.FPDFText_CountChars(textPage);
      if (count <= 0) return [];
      const lines: LineBuilder[] = [];
      for (let i = 0; i < count; i += 1) {
        const unicode = this.mod.FPDFText_GetUnicode(textPage, i);
        // Control characters (the generated CR/LF between lines) carry no
        // geometry; the baseline grouping already separates the lines.
        if (unicode < 0x20) continue;
        if (!this.mod.FPDFText_GetLooseCharBox(textPage, i, box)) continue;
        this.mod.FPDFText_GetCharOrigin(textPage, i, origin, origin + 8);
        // FS_RECTF is [left, top, right, bottom] in PDF space (y up).
        const rect = new Float32Array(this.rt.HEAPU8.buffer, box, 4);
        const left = rect[0]!;
        const top = rect[1]!;
        const right = rect[2]!;
        const bottom = rect[3]!;
        if (!(right > left) || !(top > bottom)) continue;
        const baseline = new Float64Array(this.rt.HEAPU8.buffer, origin, 2)[1]!;
        const fontSize = this.mod.FPDFText_GetFontSize(textPage, i) || top - bottom;
        let line = lines[lines.length - 1];
        const limit = line ? Math.max(line.size, fontSize) * 0.4 : 0;
        if (!line || Math.abs(baseline - line.baseline) > Math.max(2, limit)) {
          line = {
            text: "",
            x: left,
            right,
            top,
            bottom,
            baseline,
            size: fontSize,
          };
          lines.push(line);
        } else {
          // A wide horizontal gap is word spacing that the content stream did
          // not encode as a space character.
          if (
            unicode !== 0x20 &&
            !line.text.endsWith(" ") &&
            left - line.right > Math.max(1, line.size * 0.2)
          ) {
            line.text += " ";
          }
          line.x = Math.min(line.x, left);
          line.right = Math.max(line.right, right);
          line.top = Math.max(line.top, top);
          line.bottom = Math.min(line.bottom, bottom);
          line.size = Math.max(line.size, fontSize);
        }
        line.text += String.fromCodePoint(unicode);
      }
      return lines
        .map((line) => ({
          text: line.text.replace(/\s+/g, " ").trim(),
          x: line.x,
          y: size.height - line.top,
          w: line.right - line.x,
          h: line.top - line.bottom,
          size: line.size,
        }))
        .filter((line) => line.text.length > 0 && line.w > 0 && line.h > 0);
    } finally {
      this.rt.wasmExports.free(box);
      this.rt.wasmExports.free(origin);
      this.mod.FPDFText_ClosePage(textPage);
      this.mod.FPDF_ClosePage(page);
    }
  }

  /**
   * The document outline (table of contents) as the seam's raw tree, with
   * internal destinations resolved to 0-based page indices and external links
   * carrying no page. PDFium exposes the tree through `FPDFBookmark_*` and the
   * destination page through `FPDFBookmark_GetDest` +
   * `FPDFDest_GetDestPageIndex`; books without an outline return null, never an
   * error. The 1-based conversion stays in `pdfOutline.ts`.
   */
  outline(): RawPdfOutline[] | null {
    const doc = this.requireDoc();
    const first = this.mod.FPDFBookmark_GetFirstChild(doc, 0);
    if (!first) return null;
    return this.walkBookmarks(doc, first);
  }

  private walkBookmarks(doc: number, first: number): RawPdfOutline[] {
    const items: RawPdfOutline[] = [];
    let node = first;
    while (node) {
      const child = this.mod.FPDFBookmark_GetFirstChild(doc, node);
      items.push({
        title: this.bookmarkTitle(node),
        page: this.bookmarkPage(doc, node),
        items: child ? this.walkBookmarks(doc, child) : [],
      });
      node = this.mod.FPDFBookmark_GetNextSibling(doc, node);
    }
    return items;
  }

  /** Bookmark title as UTF-16 text, or "" when the title is missing. */
  private bookmarkTitle(node: number): string {
    const needed = this.mod.FPDFBookmark_GetTitle(node, 0, 0);
    if (needed <= 0) return "";
    const buffer = this.rt.wasmExports.malloc(needed);
    if (!buffer) return "";
    try {
      if (this.mod.FPDFBookmark_GetTitle(node, buffer, needed) <= 0) return "";
      return this.rt.UTF16ToString(buffer);
    } finally {
      this.rt.wasmExports.free(buffer);
    }
  }

  /**
   * Destination page of one bookmark, 0-based, or null for an external link or
   * an unresolvable destination. A bookmark may carry its destination directly
   * or through an action (`/GoTo`); both are tried.
   */
  private bookmarkPage(doc: number, node: number): number | null {
    let dest = this.mod.FPDFBookmark_GetDest(doc, node);
    if (!dest) {
      const action = this.mod.FPDFBookmark_GetAction(node);
      if (action) dest = this.mod.FPDFAction_GetDest(doc, action);
    }
    if (!dest) return null;
    const index = this.mod.FPDFDest_GetDestPageIndex(doc, dest);
    return index >= 0 ? index : null;
  }

  /**
   * Rasterizes one whole page into `width × height` device pixels and
   * returns an RGBA buffer (PDFium's device bitmaps are BGRA). The caller
   * wraps it in an `ImageBitmap` off the main thread.
   *
   * With `clip` (region in page units), only that region rasterizes, scaled
   * so the region fills the region-sized `width × height` bitmap. Deep zoom
   * then pays for a viewport buffer instead of a page-sized one.
   */
  renderRgba(
    index: number,
    width: number,
    height: number,
    clip?: PageClip,
  ): Uint8ClampedArray<ArrayBuffer> {
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
      if (clip) this.renderPageRegion(bitmap, page, clip, width, height);
      else this.mod.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0);
      return this.copyBgraToRgba(bitmap, width, height);
    } finally {
      this.mod.FPDFBitmap_Destroy(bitmap);
      this.mod.FPDF_ClosePage(page);
    }
  }

  /**
   * Clipped render through `FPDF_RenderPageBitmapWithMatrix`. The matrix maps
   * page units to the region-sized bitmap (scaling the clip origin to 0,0)
   * and the clip rect is that bitmap in device coords, so content lands at
   * the same spot it would occupy on a whole-page raster at the same scale.
   */
  private renderPageRegion(
    bitmap: number,
    page: number,
    clip: PageClip,
    width: number,
    height: number,
  ): void {
    const [left, top, clipWidth, clipHeight] = clip;
    if (!(clipWidth > 0) || !(clipHeight > 0)) {
      throw new Error(
        `PDFium: region render needs a positive size, got ${clipWidth}×${clipHeight}`,
      );
    }
    const scaleX = width / clipWidth;
    const scaleY = height / clipHeight;
    const matrix = this.rt.wasmExports.malloc(24);
    const rect = this.rt.wasmExports.malloc(16);
    if (!matrix || !rect) {
      if (matrix) this.rt.wasmExports.free(matrix);
      if (rect) this.rt.wasmExports.free(rect);
      throw new Error("PDFium: out of memory for the region transform");
    }
    try {
      const view = new DataView(this.rt.HEAPU8.buffer);
      // FS_MATRIX [a b c d e f]: scale page units, then shift the clip to 0,0.
      view.setFloat32(matrix + 0, scaleX, true);
      view.setFloat32(matrix + 4, 0, true);
      view.setFloat32(matrix + 8, 0, true);
      view.setFloat32(matrix + 12, scaleY, true);
      view.setFloat32(matrix + 16, -left * scaleX, true);
      view.setFloat32(matrix + 20, -top * scaleY, true);
      // FS_RECTF clipping is in device coords: the region-sized bitmap.
      view.setFloat32(rect + 0, 0, true);
      view.setFloat32(rect + 4, 0, true);
      view.setFloat32(rect + 8, width, true);
      view.setFloat32(rect + 12, height, true);
      this.mod.FPDF_RenderPageBitmapWithMatrix(bitmap, page, matrix, rect, 0);
    } finally {
      this.rt.wasmExports.free(matrix);
      this.rt.wasmExports.free(rect);
    }
  }

  /** Copies an RGBA-capable bitmap into a tightly packed RGBA byte array. */
  private copyBgraToRgba(
    bitmap: number,
    width: number,
    height: number,
  ): Uint8ClampedArray<ArrayBuffer> {
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
