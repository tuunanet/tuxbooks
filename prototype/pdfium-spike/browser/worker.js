// Throwaway Phase 0 spike worker (tuxbooks-koe.2). Runs PDFium-WASM in a real
// Web Worker and reports a JSON capability/performance report to the page.
// Never merged into the product.

import { init } from "@embedpdf/pdfium";

const WASM_URL = "/pdfium.wasm";

self.postMessage({ type: "progress", step: "worker-loaded" });

function progress(step, detail) {
  self.postMessage({ type: "progress", step, detail: detail ?? null });
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== "run") return;
  try {
    const report = await runSpike(msg);
    self.postMessage({ type: "report", report });
  } catch (err) {
    self.postMessage({ type: "error", error: String((err && err.stack) || err) });
  }
};

function mp(agg) {
  const sorted = [...agg].sort((a, b) => a - b);
  const at = (q) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? null };
}

function makeRangeSource(url, length) {
  const stats = { requests: 0, bytes: 0, maxRequestedEnd: 0, ranges: [] };
  function read(position, size) {
    if (position >= length) return new Uint8Array(0);
    const end = Math.min(position + size, length) - 1;
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("Range", `bytes=${position}-${end}`);
    xhr.send(null);
    if (xhr.status !== 206 && xhr.status !== 200) {
      throw new Error(`range read ${position}-${end} failed with HTTP ${xhr.status}`);
    }
    const data = new Uint8Array(xhr.response);
    stats.requests++;
    stats.bytes += data.byteLength;
    stats.maxRequestedEnd = Math.max(stats.maxRequestedEnd, position + data.byteLength);
    if (stats.ranges.length < 16) stats.ranges.push({ position, bytes: data.byteLength });
    return data;
  }
  return { read, stats };
}

function makeFileAccess(rt, source, length) {
  const heap = () => rt.HEAPU8;
  const getBlock = rt.addFunction((_param, position, pBuf, size) => {
    const data = source.read(position, size);
    heap().set(data, pBuf);
    return data.byteLength;
  }, "iiiii");
  const ptr = rt.wasmExports.malloc(12);
  const dv = new DataView(heap().buffer);
  dv.setUint32(ptr + 0, length, true);
  dv.setUint32(ptr + 4, getBlock, true);
  dv.setUint32(ptr + 8, 0, true);
  return { ptr, getBlock };
}

function pageSize(mod, rt, doc, index) {
  const out = rt.wasmExports.malloc(8);
  const ok = mod.FPDF_GetPageSizeByIndexF(doc, index, out);
  const f = new Float32Array(rt.HEAPU8.buffer, out, 2);
  const size = ok ? { width: f[0], height: f[1] } : null;
  rt.wasmExports.free(out);
  return size;
}

function renderWhole(mod, rt, doc, index, pxW, pxH) {
  const page = mod.FPDF_LoadPage(doc, index);
  if (!page) throw new Error(`FPDF_LoadPage(${index}) failed`);
  const bmp = mod.FPDFBitmap_Create(pxW, pxH, 1);
  mod.FPDFBitmap_FillRect(bmp, 0, 0, pxW, pxH, 0xffffffff);
  const t0 = performance.now();
  mod.FPDF_RenderPageBitmap(bmp, page, 0, 0, pxW, pxH, 0, 0);
  const t1 = performance.now();
  const stride = mod.FPDFBitmap_GetStride(bmp);
  const bytes = stride * pxH;
  mod.FPDFBitmap_Destroy(bmp);
  mod.FPDF_ClosePage(page);
  return { ms: t1 - t0, width: pxW, height: pxH, bytes };
}

// Region render: transform the page by `scale`, offset so the requested page
// region lands at (0,0) of a region-sized bitmap, and clip in device coords.
function renderRegion(mod, rt, doc, index, scale, region) {
  const page = mod.FPDF_LoadPage(doc, index);
  if (!page) throw new Error(`FPDF_LoadPage(${index}) failed`);
  const bmp = mod.FPDFBitmap_Create(region.width, region.height, 1);
  mod.FPDFBitmap_FillRect(bmp, 0, 0, region.width, region.height, 0xffffffff);
  const matrix = rt.wasmExports.malloc(24);
  const clip = rt.wasmExports.malloc(16);
  const dv = new DataView(rt.HEAPU8.buffer);
  const f32 = (off, v) => dv.setFloat32(off, v, true);
  f32(matrix + 0, scale);
  f32(matrix + 4, 0);
  f32(matrix + 8, 0);
  f32(matrix + 12, scale);
  f32(matrix + 16, -region.x * scale);
  f32(matrix + 20, -region.y * scale);
  f32(clip + 0, 0);
  f32(clip + 4, 0);
  f32(clip + 8, region.width);
  f32(clip + 12, region.height);
  const t0 = performance.now();
  mod.FPDF_RenderPageBitmapWithMatrix(bmp, page, matrix, clip, 0);
  const t1 = performance.now();
  const stride = mod.FPDFBitmap_GetStride(bmp);
  const bytes = stride * region.height;
  mod.FPDFBitmap_Destroy(bmp);
  mod.FPDF_ClosePage(page);
  rt.wasmExports.free(matrix);
  rt.wasmExports.free(clip);
  return { ms: t1 - t0, width: region.width, height: region.height, bytes };
}

function countNonWhite(mod, rt, bmp, limitBytes) {
  const buf = mod.FPDFBitmap_GetBuffer(bmp);
  const stride = mod.FPDFBitmap_GetStride(bmp);
  const h = mod.FPDFBitmap_GetHeight(bmp);
  const rows = Math.min(h, Math.floor(limitBytes / stride) || h);
  const px = rt.HEAPU8.subarray(buf, buf + stride * rows);
  let nonWhite = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] < 240 || px[i + 1] < 240 || px[i + 2] < 240) nonWhite++;
  }
  return nonWhite;
}

function renderColorScheme(mod, rt, doc, index, pxW, pxH) {
  const page = mod.FPDF_LoadPage(doc, index);
  const bmp = mod.FPDFBitmap_Create(pxW, pxH, 1);
  mod.FPDFBitmap_FillRect(bmp, 0, 0, pxW, pxH, 0xffffffff);
  const scheme = rt.wasmExports.malloc(16);
  const pause = rt.wasmExports.malloc(12);
  const needPause = rt.addFunction(() => 0, "ii");
  const dv = new DataView(rt.HEAPU8.buffer);
  const u32 = (off, v) => dv.setUint32(off, v, true);
  u32(scheme + 0, 0xff282828); // path fill  (dark)
  u32(scheme + 4, 0xffdcdcdc); // path stroke (light)
  u32(scheme + 8, 0xffdcdcdc); // text fill   (light)
  u32(scheme + 12, 0xff282828); // text stroke (dark)
  dv.setInt32(pause + 0, 1, true); // version, must be 1
  dv.setUint32(pause + 4, needPause, true); // NeedToPauseNow -> 0 (never)
  dv.setUint32(pause + 8, 0, true); // user data
  const t0 = performance.now();
  const status = mod.FPDF_RenderPageBitmapWithColorScheme_Start(
    bmp,
    page,
    0,
    0,
    pxW,
    pxH,
    0,
    0,
    scheme,
    pause,
  );
  let continued = null;
  if (status === 1) continued = mod.FPDF_RenderPage_Continue(page, pause);
  if (status === 1) mod.FPDF_RenderPage_Close(page);
  const t1 = performance.now();
  const nonWhite = countNonWhite(mod, rt, bmp, 512 * 1024);
  mod.FPDFBitmap_Destroy(bmp);
  mod.FPDF_ClosePage(page);
  rt.removeFunction(needPause);
  rt.wasmExports.free(scheme);
  rt.wasmExports.free(pause);
  return { ms: t1 - t0, status, continued, nonWhitePixels: nonWhite };
}

function extractText(mod, rt, doc, index) {
  const page = mod.FPDF_LoadPage(doc, index);
  const tp = mod.FPDFText_LoadPage(page);
  const chars = mod.FPDFText_CountChars(tp);
  let written = 0;
  let text = "";
  if (chars > 0) {
    const buf = rt.wasmExports.malloc((chars + 1) * 2);
    written = mod.FPDFText_GetText(tp, 0, chars, buf);
    text = rt.UTF16ToString(buf);
    rt.wasmExports.free(buf);
  }
  mod.FPDFText_ClosePage(tp);
  mod.FPDF_ClosePage(page);
  return { chars, written, sample: text.slice(0, 160), empty: text.trim().length === 0 };
}

function search(mod, rt, doc, index, needle) {
  const page = mod.FPDF_LoadPage(doc, index);
  const tp = mod.FPDFText_LoadPage(page);
  const nbuf = rt.wasmExports.malloc((needle.length + 1) * 2);
  rt.stringToUTF16(needle, nbuf, (needle.length + 1) * 2);
  const t0 = performance.now();
  const find = mod.FPDFText_FindStart(tp, nbuf, 0, 0);
  const found = mod.FPDFText_FindNext(find);
  const count = found ? mod.FPDFText_GetSchCount(find) : 0;
  const t1 = performance.now();
  mod.FPDFText_FindClose(find);
  rt.wasmExports.free(nbuf);
  mod.FPDFText_ClosePage(tp);
  mod.FPDF_ClosePage(page);
  return { needle, found: !!found, matchesOnPage: count, ms: t1 - t0 };
}

function outline(mod, rt, doc) {
  const root = mod.FPDFBookmark_GetFirstChild(doc, 0);
  if (!root) return { present: false, count: 0, titles: [] };
  const titles = [];
  let node = root;
  let count = 0;
  while (node && count < 8) {
    const needed = mod.FPDFBookmark_GetTitle(node, 0, 0);
    if (needed > 0) {
      const buf = rt.wasmExports.malloc(needed);
      mod.FPDFBookmark_GetTitle(node, buf, needed);
      titles.push(rt.UTF16ToString(buf));
      rt.wasmExports.free(buf);
    }
    const child = mod.FPDFBookmark_GetFirstChild(doc, node);
    node = child || mod.FPDFBookmark_GetNextSibling(doc, node);
    count++;
  }
  // Count all top-level bookmarks for the outline smoke.
  let total = 0;
  let top = mod.FPDFBookmark_GetFirstChild(doc, 0);
  while (top) {
    total++;
    top = mod.FPDFBookmark_GetNextSibling(doc, top);
  }
  return { present: true, count: total, titles };
}

async function runSpike({ pdfUrl, length, label }) {
  progress("fetch-wasm");
  const wasmResp = await fetch(WASM_URL);
  const wasmBinary = await wasmResp.arrayBuffer();
  progress("init");
  const tInit0 = performance.now();
  const mod = await init({ wasmBinary, locateFile: (p) => p });
  const rt = mod.pdfium;
  mod.FPDF_InitLibrary();
  mod.PDFiumExt_Init();
  const wasmInitMs = performance.now() - tInit0;
  if (typeof mod.FPDF_InitLibrary !== "function")
    throw new Error("binding missing FPDF_InitLibrary");

  progress("open");
  const source = makeRangeSource(pdfUrl, length);
  const fileAccess = makeFileAccess(rt, source, length);

  const tOpen0 = performance.now();
  const doc = mod.FPDF_LoadCustomDocument(fileAccess.ptr, "");
  const openMs = performance.now() - tOpen0;
  if (!doc) {
    const err = mod.FPDF_GetLastError();
    throw new Error(`FPDF_LoadCustomDocument failed, FPDF_GetLastError=${err}`);
  }
  const pageCount = mod.FPDF_GetPageCount(doc);
  const p0 = pageSize(mod, rt, doc, 0);

  progress("first-render");
  const tFirst0 = performance.now();
  const firstWhole = renderWhole(mod, rt, doc, 0, Math.round(p0.width), Math.round(p0.height));
  const firstRenderMs = performance.now() - tFirst0;
  const firstPaintMs = wasmInitMs + openMs + firstRenderMs;

  progress("text");
  const text = extractText(mod, rt, doc, 0);
  progress("search");
  let textPageIndex = 0;
  for (let i = 0; i < Math.min(pageCount, 40); i++) {
    const probe = extractText(mod, rt, doc, i);
    if (probe.chars > 0) {
      textPageIndex = i;
      break;
    }
  }
  const searchResult = search(mod, rt, doc, textPageIndex, label.needle);
  progress("outline");
  const outlineResult = outline(mod, rt, doc);
  progress("colorscheme");
  const csPage = Math.min(10, pageCount - 1);
  const colorScheme = renderColorScheme(
    mod,
    rt,
    doc,
    csPage,
    Math.round(p0.width),
    Math.round(p0.height),
  );

  // Whole-page raster sampling at native scale across pages (PERF-2 raster latency).
  progress("whole-page-sampling");
  const samplePages = Math.min(pageCount, 20);
  const wholeTimes = [];
  let wholeBytes = 0;
  for (let i = 0; i < samplePages; i++) {
    const s = pageSize(mod, rt, doc, i);
    const r = renderWhole(
      mod,
      rt,
      doc,
      i,
      Math.max(1, Math.round(s.width)),
      Math.max(1, Math.round(s.height)),
    );
    wholeTimes.push(r.ms);
    wholeBytes = Math.max(wholeBytes, r.bytes);
  }

  // Reference-condition raster: letter page fit to a 3840-wide viewport (dpr 1)
  // means a ~6.27x scale, so the whole page is ~19 MP and the dpr-2 buffer
  // (~76 MP) exceeds the PERF-1 2^25 cap. PERF-17 then requires region render.
  const refPage = 0;
  const refSize = p0;
  const fitScale = 3840 / refSize.width;
  progress("whole-reference");
  const wholeRef = {
    scale: fitScale,
    ...renderWhole(
      mod,
      rt,
      doc,
      refPage,
      Math.round(refSize.width * fitScale),
      Math.round(refSize.height * fitScale),
    ),
  };
  const regionW = 3840;
  const regionH = 2160;
  progress("region-dpr1");
  const regionRefDpr1 = {
    scale: fitScale,
    ...renderRegion(mod, rt, doc, refPage, fitScale, {
      x: 0,
      y: 0,
      width: regionW,
      height: regionH,
    }),
  };
  progress("region-dpr2");
  const regionRefDpr2 = {
    scale: fitScale * 2,
    ...renderRegion(mod, rt, doc, refPage, fitScale * 2, {
      x: 0,
      y: 0,
      width: regionW * 2,
      height: regionH * 2,
    }),
  };

  // PERF-2 at reference conditions: p95 raster latency of the region actually
  // rasterized on a dpr-2 3840-wide viewport (the whole page would exceed the
  // PERF-1 cap, so PERF-17 forces a region render of the visible area).
  progress("reference-region-sampling");
  const refRegionTimes = [];
  const refSamplePages = Math.min(pageCount, 12);
  for (let i = 0; i < refSamplePages; i++) {
    const s = pageSize(mod, rt, doc, i);
    const scale = (3840 / s.width) * 2;
    const r = renderRegion(mod, rt, doc, i, scale, {
      x: 0,
      y: 0,
      width: regionW * 2,
      height: regionH * 2,
    });
    refRegionTimes.push(r.ms);
  }

  const result = {
    label: label.text,
    pdfUrl,
    fileBytes: length,
    wasm: { initMs: wasmInitMs, wasmBytes: wasmBinary.byteLength },
    open: { ms: openMs, pageCount, page0: p0 },
    firstPaint: { firstRenderMs, firstPaintMs },
    range: {
      ...source.stats,
      wholeFileCrossed: source.stats.maxRequestedEnd >= length && source.stats.bytes >= length,
    },
    renders: {
      whole1x: firstWhole,
      wholeReferenceFitWidth: wholeRef,
      regionReferenceDpr1: regionRefDpr1,
      regionReferenceDpr2: regionRefDpr2,
    },
    wholePageRaster: mp(wholeTimes),
    referenceRegionRasterDpr2: mp(refRegionTimes),
    text,
    search: { ...searchResult, pageIndex: textPageIndex },
    outline: outlineResult,
    colorScheme: { ...colorScheme, pageIndex: csPage },
  };

  mod.FPDF_CloseDocument(doc);
  rt.wasmExports.free(fileAccess.ptr);
  rt.removeFunction(fileAccess.getBlock);
  mod.FPDF_DestroyLibrary();
  return result;
}
