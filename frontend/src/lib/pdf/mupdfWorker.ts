/**
 * The MuPDF worker: every MuPDF/WASM object lives here, and all rasterization
 * and text extraction run off the UI thread (docs/PDF.md). One worker instance
 * serves one document; the main-thread side (pdfEngine.ts) terminates the
 * worker when the document closes, which frees the whole WASM heap.
 *
 * Protocol: request `{ id, method, params }`, response
 * `{ id, ok: true, result }` / `{ id, ok: false, error }`. Render responses
 * transfer an ImageBitmap. Open accepts either transferred PDF bytes or a
 * `bookUrl` (`tuxbooks://book/<id>`), which is opened through a
 * random-access `mupdf.Stream` whose reads become HTTP Range requests —
 * so a document opens (and page 1 renders) long before the whole file has
 * crossed the bridge.
 *
 * The library is imported lazily on the first `open`: the emscripten glue
 * resolves its `mupdf-wasm.wasm` through `Module.locateFile` at import time,
 * and the bundler's default resolution (relative to the worker chunk) never
 * finds the asset — so the main thread passes an absolute URL in the open
 * request and the global is pinned before the dynamic import.
 */

import {
  classifyRasterImage,
  deviceColorToRgb,
  imageStatsFromSampler,
  recolorColor,
  recolorPixelsInPlace,
  PAGE_IMAGE_COVERAGE_THRESHOLD,
  type Rgb,
  type SmartPalette,
  type RasterImageTreatment,
} from "./smartColors";
import { TransformedImageCache } from "./transformedImageCache";

type WorkerRequest =
  | {
      id: number;
      method: "open";
      params:
        | { wasmUrl: string; data: ArrayBuffer; offset: number; length: number }
        | { wasmUrl: string; bookUrl: string };
    }
  | { id: number; method: "prewarm"; params: { wasmUrl: string } }
  | { id: number; method: "pageSize"; params: { page: number } }
  | {
      id: number;
      method: "render";
      params: {
        page: number;
        width: number;
        height: number;
        /** Smart Dark recoloring palette (issue #67); absent = render as-is. */
        smart?: { background: number[]; text: number[] };
      };
    }
  | { id: number; method: "text"; params: { page: number } }
  | { id: number; method: "outline"; params?: undefined };

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Out-of-band worker diagnostic, sent without a request id so it never
 * resolves a request. The engine forwards these to the renderer console,
 * which the main process captures; the last one therefore survives a
 * renderer crash and pins the operation in flight (and the WASM heap at
 * that point — `wasmHeapBytes` is the leak signal).
 */
interface WorkerDiag {
  kind: "pdf-worker-diag";
  phase: "begin" | "end" | "error" | "unhandled";
  method: string;
  requestId: number;
  page?: number;
  ms?: number;
  heapBytes: number;
  message?: string;
}

type MupdfModule = typeof import("mupdf");
type MupdfDocument = InstanceType<MupdfModule["Document"]>;
type MupdfColor = import("mupdf").Color;

let mupdf: MupdfModule | null = null;
let document: MupdfDocument | null = null;

/**
 * Byte length of the MuPDF WASM linear memory. Emscripten populates HEAPU8
 * on the module config object we hand it; the heap never shrinks, so a
 * monotonically rising value across renders means native objects are not
 * being released. Zero before the engine loads.
 */
function wasmHeapBytes(): number {
  const heap = (globalThis as { $libmupdf_wasm_Module?: { HEAPU8?: Uint8Array } })
    .$libmupdf_wasm_Module?.HEAPU8;
  return heap ? heap.buffer.byteLength : 0;
}

/** Post one diagnostic; never throws (the worker may be tearing down). */
function postDiag(diag: WorkerDiag): void {
  try {
    (self as unknown as Worker).postMessage(diag);
  } catch {
    // Structured-clone failure or a closing worker: diagnostics are optional.
  }
}

/**
 * Generation of the open document, mixed into the per-image decision keys so
 * a reopened document can never inherit the previous document's decisions.
 */
let documentGeneration = 0;

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

/**
 * Default read-ahead chunk for range-backed documents (1 MiB). MuPDF reads
 * the xref trail, page tree, and page 1 content from scattered offsets; a
 * chunk cache turns those scatter reads into a handful of range requests
 * instead of one per object.
 */
const STREAM_CHUNK_BYTES = 1024 * 1024;
/** Bounded chunk cache (≈64 MiB): enough locality, never unbounded growth. */
const STREAM_MAX_CACHED_CHUNKS = 64;

/**
 * Random-access adapter over `tuxbooks://book/<id>` for `mupdf.Stream`.
 * MuPDF's stream callbacks are synchronous, so reads use synchronous XHR —
 * legal (and only legal) inside a worker — and block this worker exactly
 * like the synchronous rasterization it interleaves with. Each miss fetches
 * one `STREAM_CHUNK_BYTES` range from the sidecar through the Electron
 * protocol handler; `fileSize()` reads the total out of a one-byte range's
 * `content-range` header.
 */
class RangeStreamHandle {
  private readonly chunks = new Map<number, ArrayBuffer>();
  private size: number | null = null;

  constructor(
    private readonly bookUrl: string,
    private readonly chunkBytes = STREAM_CHUNK_BYTES,
  ) {}

  fileSize(): number {
    if (this.size === null) {
      // A 1-byte range returns 206 with `content-range: bytes 0-0/TOTAL`;
      // parse the total out of it without ever fetching the file.
      const response = this.request("bytes=0-0");
      if (response.status === 206) {
        const total = /\/(\d+)$/.exec(response.headers["content-range"] ?? "")?.[1];
        if (!total) throw new Error("range response missing content-range total");
        this.size = Number(total);
      } else if (response.status === 200) {
        // Range-unaware response: the body is the whole file.
        this.size = response.body.byteLength;
        if (response.body.byteLength > 0) {
          this.chunks.set(0, response.body);
        }
      } else {
        throw new Error(`failed to stat ${this.bookUrl}: ${response.status}`);
      }
    }
    return this.size;
  }

  read(memory: Uint8Array, offset: number, length: number, position: number): number {
    const total = this.fileSize();
    if (position >= total) return 0;
    const end = Math.min(position + length, total);
    let cursor = position;
    while (cursor < end) {
      const chunkIndex = Math.floor(cursor / this.chunkBytes);
      const chunk = new Uint8Array(this.chunk(chunkIndex, total));
      const chunkStart = chunkIndex * this.chunkBytes;
      const from = cursor - chunkStart;
      const count = Math.min(end - cursor, chunk.length - from);
      memory.set(chunk.subarray(from, from + count), offset + (cursor - position));
      cursor += count;
    }
    return end - position;
  }

  close(): void {
    this.chunks.clear();
  }

  private chunk(chunkIndex: number, total: number): ArrayBuffer {
    const cached = this.chunks.get(chunkIndex);
    if (cached) {
      // Refresh for LRU order (Map iteration is insertion-ordered).
      this.chunks.delete(chunkIndex);
      this.chunks.set(chunkIndex, cached);
      return cached;
    }
    const start = chunkIndex * this.chunkBytes;
    const end = Math.min(start + this.chunkBytes, total) - 1;
    const response = this.request(`bytes=${start}-${end}`);
    let body: ArrayBuffer;
    if (response.status === 206) {
      body = response.body;
    } else if (response.status === 200) {
      // Range-unaware response: the body is the whole file; slice it.
      body = response.body.slice(start, end + 1);
    } else {
      throw new Error(`failed to read ${this.bookUrl}@${start}-${end}: ${response.status}`);
    }
    this.chunks.set(chunkIndex, body);
    while (this.chunks.size > STREAM_MAX_CACHED_CHUNKS) {
      const oldest = this.chunks.keys().next().value;
      if (oldest === undefined) break;
      this.chunks.delete(oldest);
    }
    return body;
  }

  private request(range: string): {
    status: number;
    body: ArrayBuffer;
    headers: Record<string, string>;
  } {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", this.bookUrl, false);
    xhr.setRequestHeader("Range", range);
    xhr.responseType = "arraybuffer";
    xhr.send(null);
    const headers: Record<string, string> = {};
    for (const name of ["content-range"]) {
      const value = xhr.getResponseHeader(name);
      if (value !== null) headers[name] = value;
    }
    return {
      status: xhr.status,
      body: (xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0),
      headers,
    };
  }
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

/* -------------------------------------------------------------------------- */
/* Smart Dark (issue #67) — object-aware recoloring inside the render device. */

/** Per-image classifications (decisions only); keys carry the doc generation. */
const imageDecisions = new Map<string, RasterImageTreatment>();
const IMAGE_DECISIONS_CAP = 4096;

/**
 * Transformed (recolored) scan images reused across a document's renders.
 * The cache owns the MuPDF images and frees them on eviction: they hold a
 * page-scale pixmap each, which the worker's GC is too lazy to release.
 */
const TRANSFORMED_IMAGE_ENTRIES = 2;
const transformedImages = new TransformedImageCache<InstanceType<MupdfModule["Image"]>>(
  TRANSFORMED_IMAGE_ENTRIES,
);
/** Images above this pixel count are transformed per render, never cached. */
const TRANSFORMED_IMAGE_MAX_PIXELS = 4 * 1024 * 1024;

/** Cap on sampled pixels while classifying one image (classification only). */
const IMAGE_STATS_MAX_SAMPLES = 8192;

function normalizeSmartPalette(
  smart: { background: number[]; text: number[] } | undefined,
): SmartPalette | null {
  if (!smart) return null;
  const [br, bg, bb] = smart.background;
  const [tr, tg, tb] = smart.text;
  const values = [br, bg, bb, tr, tg, tb];
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    return null;
  }
  return {
    background: [br!, bg!, bb!] as Rgb,
    text: [tr!, tg!, tb!] as Rgb,
  };
}

/**
 * Recolor a fill/stroke/text/image-mask paint color onto the palette.
 * Returns the (colorspace, color) pair to forward, or null to forward the
 * operation unchanged — an unknown colorspace (Indexed, Separation, …) or a
 * conversion failure must never drop a drawing op.
 */
function recoloredColor(
  palette: SmartPalette,
  color: number[],
  colorspace: InstanceType<MupdfModule["ColorSpace"]>,
): { colorspace: InstanceType<MupdfModule["ColorSpace"]>; color: Rgb } | null {
  try {
    const rgb = deviceColorToRgb(color, colorspace.getType(), colorspace.getNumberOfComponents());
    if (!rgb) return null;
    return { colorspace: mupdf!.ColorSpace.DeviceRGB, color: recolorColor(rgb, palette) };
  } catch {
    return null;
  }
}

/**
 * Classify (and for scans, transform) one raster image draw. The decision
 * is cached per document+page+ordinal so re-renders at different scales
 * never pay the analysis twice; the transformed image itself is cached in a
 * two-entry LRU (bounded by count, and only for images that fit the pixel
 * cap) so the two-stage first paint does not transform a scan twice.
 *
 * The ORIGINAL image's decoded pixmap is only ever read: the recolor works
 * on a private DeviceRGB copy (`convertToColorSpace` allocates), because
 * the decode result is owned by MuPDF's per-image cache and mutating it
 * would corrupt later renders.
 *
 * `ctm` is the interpreter's image→page-space transform: the draw device
 * concatenates its own creation transform internally (fz_draw_fill_image
 * does `fz_concat(in_ctm, dev->transform)`), so the page-space image area
 * comes straight from this matrix's determinant.
 */
/** Classify once per document+page+ordinal, caching the decision. */
function decisionFor(
  image: InstanceType<MupdfModule["Image"]>,
  decisionKey: string,
  coverage: number,
): RasterImageTreatment {
  const cached = imageDecisions.get(decisionKey);
  if (cached) return cached;
  const decision = classifyRasterized(image, coverage);
  if (imageDecisions.size >= IMAGE_DECISIONS_CAP) imageDecisions.clear();
  imageDecisions.set(decisionKey, decision);
  return decision;
}

/**
 * A recolored image to draw, plus who owns it. Cached images live in the LRU
 * and must not be freed by the caller; a transient one (a scan past the pixel
 * cap, transformed per render) is owned by the caller and must be destroyed
 * after the fill operation, or its pixmap leaks until GC.
 */
interface ImageTreatment {
  image: InstanceType<MupdfModule["Image"]>;
  transient: boolean;
}

function treatImage(
  image: InstanceType<MupdfModule["Image"]>,
  ctm: number[],
  page: number,
  ordinal: number,
  pageArea: number,
  palette: SmartPalette,
): ImageTreatment | null {
  // Page-space area of the image rect ÷ page area = coverage.
  const ctmDet = Math.abs((ctm[0] ?? 0) * (ctm[3] ?? 0) - (ctm[1] ?? 0) * (ctm[2] ?? 0));
  const coverage = pageArea > 0 ? ctmDet / pageArea : 0;
  if (coverage < PAGE_IMAGE_COVERAGE_THRESHOLD) {
    return null; // Illustration/screenshot-sized: never analyzed, never touched.
  }

  const decisionKey = `${documentGeneration}:${page}:${ordinal}`;
  if (decisionFor(image, decisionKey, coverage) === "preserve") {
    return null;
  }

  // Huge scans transform per render; the LRU is reserved for ordinary
  // page-sized scans so a pathological image cannot pin the cache.
  const cacheable = image.getWidth() * image.getHeight() <= TRANSFORMED_IMAGE_MAX_PIXELS;
  if (cacheable) {
    const cached = transformedImages.get(decisionKey);
    if (cached) return { image: cached, transient: false };
  }
  const transformed = buildRecoloredImage(image, palette);
  if (!transformed) return null;
  if (cacheable) {
    transformedImages.set(decisionKey, transformed);
    return { image: transformed, transient: false };
  }
  return { image: transformed, transient: true };
}

/** Decode + classify one page-covering image (stats only, read-only). */
function classifyRasterized(
  image: InstanceType<MupdfModule["Image"]>,
  coverage: number,
): RasterImageTreatment {
  let source: InstanceType<MupdfModule["Pixmap"]> | null = null;
  let colorspace: InstanceType<MupdfModule["ColorSpace"]> | null = null;
  try {
    source = image.toPixmap();
    colorspace = source.getColorSpace();
    if (!colorspace) return "preserve";
    const type = colorspace.getType();
    if (type !== "RGB" && type !== "Gray" && type !== "BGR") {
      // CMYK and exotic spaces: sample through a private RGB conversion.
      const converted = source.convertToColorSpace(mupdf!.ColorSpace.DeviceRGB, false);
      try {
        return classifyFromPixmap(converted, coverage);
      } finally {
        converted.destroy();
      }
    }
    return classifyFromPixmap(source, coverage);
  } catch {
    return "preserve";
  } finally {
    colorspace?.destroy();
    source?.destroy();
  }
}

/** Sample a pixmap (read-only) and classify it. */
function classifyFromPixmap(
  pixmap: InstanceType<MupdfModule["Pixmap"]>,
  coverage: number,
): RasterImageTreatment {
  const pixels = pixmap.getPixels();
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const stride = pixmap.getStride();
  const alpha = pixmap.getAlpha();
  const components = pixmap.getNumberOfComponents() + alpha;
  // Retained wrapper: read the type, then release it (only the type is used).
  const colorspace = pixmap.getColorSpace();
  const type = colorspace?.getType() ?? "RGB";
  colorspace?.destroy();
  const total = width * height;
  if (total === 0 || stride === 0 || components <= 0) return "preserve";
  // Deterministic stride sampling: every `step`-th pixel in linear order,
  // bounded at IMAGE_STATS_MAX_SAMPLES samples.
  const step = Math.max(1, Math.floor(total / IMAGE_STATS_MAX_SAMPLES));
  const samples = Math.ceil(total / step);
  let next = 0;
  const stats = imageStatsFromSampler(() => {
    const index = next;
    next += step;
    if (index >= total) return null;
    const base = Math.floor(index / width) * stride + (index % width) * components;
    if (base + components > pixels.length) return null;
    const a = alpha === 1 ? (pixels[base + components - 1] ?? 0) / 255 : 1;
    if (type === "Gray") {
      const gray = (pixels[base] ?? 0) / 255;
      return { rgb: [gray, gray, gray], alpha: a };
    }
    const r = type === "BGR" ? (pixels[base + 2] ?? 0) : (pixels[base] ?? 0);
    const b = type === "BGR" ? (pixels[base] ?? 0) : (pixels[base + 2] ?? 0);
    return { rgb: [r / 255, (pixels[base + 1] ?? 0) / 255, b / 255], alpha: a };
  }, samples);
  return classifyRasterImage(stats, coverage);
}

/**
 * Build the recolored stand-in image for a classified scan: private DeviceRGB
 * copy, in-place palette remap, new Image (which takes ownership of the
 * pixmap's reference). Null when the image cannot be processed (no colorspace,
 * conversion failure) — the caller then forwards the original unchanged.
 */
function buildRecoloredImage(
  image: InstanceType<MupdfModule["Image"]>,
  palette: SmartPalette,
): InstanceType<MupdfModule["Image"]> | null {
  let source: InstanceType<MupdfModule["Pixmap"]> | null = null;
  try {
    source = image.toPixmap();
    // getColorSpace() returns a retained wrapper; it is only a presence check
    // here, so release it before the conversion.
    const colorspace = source.getColorSpace();
    if (!colorspace) return null;
    colorspace.destroy();
    const keepAlpha = source.getAlpha() === 1;
    // Always through a private copy: the decoded pixmap returned by
    // toPixmap() is owned by MuPDF's per-image decode cache, so mutating it
    // in place would corrupt later renders of the same image.
    const copy = source.convertToColorSpace(mupdf!.ColorSpace.DeviceRGB, keepAlpha);
    try {
      source.destroy();
      source = null;
      const components = copy.getNumberOfComponents() + (copy.getAlpha() === 1 ? 1 : 0);
      recolorPixelsInPlace(
        copy.getPixels(),
        components,
        copy.getStride(),
        copy.getHeight(),
        palette,
      );
      return new mupdf!.Image(copy);
    } finally {
      copy.destroy();
    }
  } catch {
    return null;
  } finally {
    source?.destroy();
  }
}

/**
 * Release the objects the engine's JS-device binding wrapped for one
 * callback. The binding keeps a native reference per argument
 * (`_wasm_keep_path` and friends) and expects JavaScript garbage collection
 * to drop it; under the worker's allocation profile that never keeps up, so
 * the WASM heap grows with every operation until the renderer dies. Dropping
 * each wrapper right after it has been forwarded balances the reference
 * deterministically. `Shade` is the one borrowed argument (no keep) and must
 * not be dropped here.
 */
function releaseDeviceArgs(...objects: { destroy(): void }[]): void {
  for (const object of objects) object.destroy();
}

/**
 * The Smart Dark render device: a MuPDF JavaScript Device that forwards
 * every operation to a DrawDevice painting the target pixmap, remapping
 * fill/stroke/text/image-mask paint colors onto the dark palette and
 * leaving ordinary raster images untouched. Every callback must forward —
 * an omitted callback is a no-op on the native side, which would silently
 * drop clips, groups, masks, and tiles. Every callback must also release
 * its arguments (see `releaseDeviceArgs`) or the WASM heap leaks per op.
 */
function makeSmartRecolorDevice(
  draw: InstanceType<MupdfModule["DrawDevice"]>,
  palette: SmartPalette,
  page: number,
  pageArea: number,
): InstanceType<MupdfModule["Device"]> {
  let imageOrdinal = 0;
  return new mupdf!.Device({
    close: () => draw.close(),
    fillPath: (path, evenOdd, ctm, colorspace, color, alpha) => {
      const mapped = recoloredColor(palette, color, colorspace);
      if (mapped) draw.fillPath(path, evenOdd, ctm, mapped.colorspace, mapped.color, alpha);
      else draw.fillPath(path, evenOdd, ctm, colorspace, color as MupdfColor, alpha);
      releaseDeviceArgs(path, colorspace);
    },
    strokePath: (path, stroke, ctm, colorspace, color, alpha) => {
      const mapped = recoloredColor(palette, color, colorspace);
      if (mapped) draw.strokePath(path, stroke, ctm, mapped.colorspace, mapped.color, alpha);
      else draw.strokePath(path, stroke, ctm, colorspace, color as MupdfColor, alpha);
      releaseDeviceArgs(path, stroke, colorspace);
    },
    clipPath: (path, evenOdd, ctm) => {
      draw.clipPath(path, evenOdd, ctm);
      releaseDeviceArgs(path);
    },
    clipStrokePath: (path, stroke, ctm) => {
      draw.clipStrokePath(path, stroke, ctm);
      releaseDeviceArgs(path, stroke);
    },
    fillText: (text, ctm, colorspace, color, alpha) => {
      const mapped = recoloredColor(palette, color, colorspace);
      if (mapped) draw.fillText(text, ctm, mapped.colorspace, mapped.color, alpha);
      else draw.fillText(text, ctm, colorspace, color as MupdfColor, alpha);
      releaseDeviceArgs(text, colorspace);
    },
    strokeText: (text, stroke, ctm, colorspace, color, alpha) => {
      const mapped = recoloredColor(palette, color, colorspace);
      if (mapped) draw.strokeText(text, stroke, ctm, mapped.colorspace, mapped.color, alpha);
      else draw.strokeText(text, stroke, ctm, colorspace, color as MupdfColor, alpha);
      releaseDeviceArgs(text, stroke, colorspace);
    },
    clipText: (text, ctm) => {
      draw.clipText(text, ctm);
      releaseDeviceArgs(text);
    },
    clipStrokeText: (text, stroke, ctm) => {
      draw.clipStrokeText(text, stroke, ctm);
      releaseDeviceArgs(text, stroke);
    },
    ignoreText: (text, ctm) => {
      draw.ignoreText(text, ctm);
      releaseDeviceArgs(text);
    },
    fillShade: (shade, ctm, alpha) => draw.fillShade(shade, ctm, alpha),
    fillImage: (image, ctm, alpha) => {
      const treatment = treatImage(image, ctm, page, imageOrdinal++, pageArea, palette);
      draw.fillImage(treatment?.image ?? image, ctm, alpha);
      releaseDeviceArgs(image);
      // A transient recoloring (a scan past the pixel cap) is ours alone; the
      // draw device has consumed it, so free its pixmap now instead of
      // waiting for a GC that never runs.
      if (treatment?.transient) treatment.image.destroy();
    },
    fillImageMask: (image, ctm, colorspace, color, alpha) => {
      // Image masks are stencil shapes painted a flat color (faxed text,
      // knockouts): the paint follows the text/line rules, the mask itself
      // passes through.
      const mapped = recoloredColor(palette, color, colorspace);
      if (mapped) draw.fillImageMask(image, ctm, mapped.colorspace, mapped.color, alpha);
      else draw.fillImageMask(image, ctm, colorspace, color as MupdfColor, alpha);
      releaseDeviceArgs(image, colorspace);
    },
    clipImageMask: (image, ctm) => {
      draw.clipImageMask(image, ctm);
      releaseDeviceArgs(image);
    },
    popClip: () => draw.popClip(),
    beginMask: (area, luminosity, colorspace, color) => {
      const mapped = recoloredColor(palette, color, colorspace);
      if (mapped) draw.beginMask(area, luminosity, mapped.colorspace, mapped.color);
      else draw.beginMask(area, luminosity, colorspace, color as MupdfColor);
      releaseDeviceArgs(colorspace);
    },
    endMask: () => draw.endMask(),
    beginGroup: (area, colorspace, isolated, knockout, blendmode, alpha) => {
      draw.beginGroup(area, colorspace, isolated, knockout, blendmode, alpha);
      releaseDeviceArgs(colorspace);
    },
    endGroup: () => draw.endGroup(),
    beginTile: (area, view, xstep, ystep, ctm, id, docId) =>
      draw.beginTile(area, view, xstep, ystep, ctm, id, docId),
    endTile: () => draw.endTile(),
    beginLayer: (name) => draw.beginLayer(name),
    endLayer: () => draw.endLayer(),
  });
}

/**
 * The Smart Dark render path (issue #67): the page runs through a
 * recoloring Device into a DrawDevice painting the same DeviceRGB/alpha
 * pixmap the plain path produces, so the main-thread contract (ImageBitmap
 * in page pixels) is unchanged. Reproduces fz_new_pixmap_from_page
 * semantics exactly as the plain path's toPixmap(): pixmap bbox from the
 * page bounds × transform, transparent clear (alpha), run page (contents +
 * annotations + widgets), close device.
 *
 * The page background is pre-filled with the palette's background color
 * through the draw device before the content runs: a PDF does not paint its
 * own page background — viewers supply the white — so without this, a page
 * without an explicit background fill would stay transparent and read
 * white over the reader's white page slot in dark mode.
 */
async function renderSmartPage(
  page: number,
  width: number,
  height: number,
  palette: SmartPalette,
): Promise<{ width: number; height: number; bitmap: ImageBitmap }> {
  if (!mupdf || !document) throw new Error("no document open");
  const loaded = document.loadPage(page - 1);
  try {
    const bounds = loaded.getBounds();
    const [x0, y0, x1, y1] = bounds;
    const pageWidth = x1 - x0;
    const pageHeight = y1 - y0;
    const ctm = mupdf.Matrix.scale(width / pageWidth, height / pageHeight);
    const bbox = mupdf.Rect.transform(bounds, ctm);
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
    try {
      pixmap.clear(0);
      const draw = new mupdf.DrawDevice(ctm, pixmap);
      const backgroundPath = new mupdf.Path();
      try {
        backgroundPath.rect(x0, y0, x1, y1);
        // The path is already in page space and the draw device concatenates
        // its own page→device transform internally, so the identity matrix is
        // the correct in_ctm here — the render ctm would double-scale.
        draw.fillPath(
          backgroundPath,
          false,
          mupdf.Matrix.identity,
          mupdf.ColorSpace.DeviceRGB,
          palette.background,
          1,
        );
      } finally {
        backgroundPath.destroy();
      }
      const smart = makeSmartRecolorDevice(draw, palette, page, pageWidth * pageHeight);
      try {
        loaded.run(smart, mupdf.Matrix.identity);
      } finally {
        // fz_close_device: flushes pending groups/masks/blends, matching the
        // plain path's toPixmap internals.
        smart.close();
        // Free the JS device and its draw target now: relying on worker GC
        // leaves the whole device graph (and the pixmap reference it holds)
        // in the WASM heap for the life of the worker.
        smart.destroy();
        draw.destroy();
      }
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
}

const methods = {
  async prewarm({ wasmUrl }: { wasmUrl: string }): Promise<{ ready: boolean }> {
    // Engine load only: no document, no allocation, no rasterization.
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
    const mod = await ensureEngine(params.wasmUrl);
    document?.destroy();
    // A switched book must never inherit the previous document's Smart Dark
    // image decisions (they are keyed per page/ordinal, but the generation
    // guard makes cross-document collisions impossible by construction).
    documentGeneration += 1;
    transformedImages.clear();
    if (params.bookUrl !== undefined) {
      // Range-backed open: MuPDF pulls only the ranges it needs (xref trail
      // first, page 1 content next) straight off tuxbooks://.
      const handle = new RangeStreamHandle(params.bookUrl);
      document = mod.Document.openDocument(new mod.Stream(handle), "application/pdf");
    } else {
      const data = params.data;
      if (data === undefined) throw new Error("open requires data or bookUrl");
      const view = new Uint8Array(data, params.offset, params.length);
      document = mod.Document.openDocument(view, "application/pdf");
    }
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
    smart,
  }: {
    page: number;
    width: number;
    height: number;
    smart?: { background: number[]; text: number[] };
  }): Promise<{ width: number; height: number; bitmap: ImageBitmap }> {
    if (!mupdf || !document) throw new Error("no document open");
    const palette = normalizeSmartPalette(smart);
    if (palette) {
      return renderSmartPage(page, width, height, palette);
    }
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

// js/missing-origin-check triage (dismissed "false positive" on the
// code-scanning alert): dedicated workers only receive messages from the
// creating document — a same-origin module worker — and under the app's
// `tuxbooks://` custom protocol that origin is opaque ("null"), so a
// literal origin check is impossible. Requests are additionally validated
// by the method dispatch below.
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
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
    heapBytes: wasmHeapBytes(),
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
      heapBytes: wasmHeapBytes(),
    });
    if (result?.bitmap instanceof ImageBitmap) {
      // The bitmap is transferred in place: the structured clone keeps the
      // property, the transfer list moves the pixel buffer itself.
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
      heapBytes: wasmHeapBytes(),
      message,
    });
    respond({ id: request.id, ok: false, error: message });
  }
};

// A worker that dies to an uncaught error reports the operation in flight
// (and the heap state) before the engine's request rejection surfaces; the
// worker console itself would be lost with the renderer.
self.addEventListener("unhandledrejection", (event) => {
  postDiag({
    kind: "pdf-worker-diag",
    phase: "unhandled",
    method: "unhandledrejection",
    requestId: 0,
    heapBytes: wasmHeapBytes(),
    message: event.reason instanceof Error ? event.reason.message : String(event.reason),
  });
});
self.addEventListener("error", (event) => {
  postDiag({
    kind: "pdf-worker-diag",
    phase: "unhandled",
    method: "error",
    requestId: 0,
    heapBytes: wasmHeapBytes(),
    message: event.message,
  });
});
