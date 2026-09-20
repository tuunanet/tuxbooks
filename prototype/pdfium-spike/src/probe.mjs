import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

const wasmPath = require.resolve("@embedpdf/pdfium/pdfium.wasm");
const wasmBinary = readFileSync(wasmPath);
console.log("wasm bytes:", wasmBinary.byteLength);

const { init } = await import("@embedpdf/pdfium");
const mod = await init({ wasmBinary });
const rt = mod.pdfium;
console.log(
  "init ok; FPDF_InitLibrary:",
  typeof mod.FPDF_InitLibrary,
  "PDFiumExt_Init:",
  typeof mod.PDFiumExt_Init,
);
mod.FPDF_InitLibrary();
if (typeof mod.PDFiumExt_Init === "function") mod.PDFiumExt_Init();

const PDF_PATH =
  process.argv[2] ??
  "/home/tuunanet/git/tuunanet/tuxbooks/tests/fixtures/books/EBooks/Papers/GeoTopo.pdf";
const bytes = readFileSync(PDF_PATH);
console.log("pdf bytes:", bytes.length, PDF_PATH);

// Allocate the whole PDF in wasm memory for the mem-load path probe.
const lenPtr = rt.wasmExports.malloc(bytes.length);
rt.HEAPU8.set(bytes, lenPtr);
const doc = mod.FPDF_LoadMemDocument(lenPtr, bytes.length, "");
console.log("FPDF_LoadMemDocument ->", doc);
if (!doc) {
  console.log("last error:", mod.FPDF_GetLastError());
  process.exit(1);
}
const pageCount = mod.FPDF_GetPageCount(doc);
console.log("page count:", pageCount);

// page size via FPDF_GetPageSizeByIndexF (FS_SIZEF = 2 floats)
const sizePtr = rt.wasmExports.malloc(8);
const okSize = mod.FPDF_GetPageSizeByIndexF(doc, 0, sizePtr);
const w = new Float32Array(rt.HEAPU8.buffer, sizePtr, 1)[0];
const h = new Float32Array(rt.HEAPU8.buffer, sizePtr + 4, 1)[0];
console.log("FPDF_GetPageSizeByIndexF:", okSize, "size:", w, h);

// Render page 0 at scale 1
const page = mod.FPDF_LoadPage(doc, 0);
console.log("page ptr:", page);
const pxW = Math.round(w);
const pxH = Math.round(h);
const bitmap = mod.FPDFBitmap_Create(pxW, pxH, 1); // 1 = alpha
mod.FPDFBitmap_FillRect(bitmap, 0, 0, pxW, pxH, 0xffffffff);
const t0 = performance.now();
mod.FPDF_RenderPageBitmap(bitmap, page, 0, 0, pxW, pxH, 0, 0);
const t1 = performance.now();
const buf = mod.FPDFBitmap_GetBuffer(bitmap);
const stride = mod.FPDFBitmap_GetStride(bitmap);
console.log(
  "render whole page:",
  (t1 - t0).toFixed(2),
  "ms",
  pxW + "x" + pxH,
  "buf",
  buf,
  "stride",
  stride,
);
console.log("pixel sample:", Array.from(rt.HEAPU8.slice(buf, buf + 8)));

// Text extraction
const textPage = mod.FPDFText_LoadPage(page);
const nChars = mod.FPDFText_CountChars(textPage);
console.log("chars:", nChars);
const textBuf = rt.wasmExports.malloc((nChars + 1) * 2);
const got = mod.FPDFText_GetText(textPage, 0, Math.min(nChars, 200), textBuf);
console.log("FPDFText_GetText ->", got, "text:", rt.UTF16ToString(textBuf).slice(0, 120));

// Search: encode needle UTF-16LE
const needle = "the";
const needlePtr = rt.wasmExports.malloc((needle.length + 1) * 2);
rt.stringToUTF16(needle, needlePtr, (needle.length + 1) * 2);
const find = mod.FPDFText_FindStart(textPage, needlePtr, 0, 0);
const found = mod.FPDFText_FindNext(find);
console.log("search 'the' ->", found);
mod.FPDFText_FindClose(find);

// Outline
const root = mod.FPDFBookmark_GetFirstChild(doc, 0);
console.log("outline root:", root);
if (root) {
  const titleLen = mod.FPDFBookmark_GetTitle(root, 0, 0);
  const titleBuf = rt.wasmExports.malloc(titleLen);
  mod.FPDFBookmark_GetTitle(root, titleBuf, titleLen);
  console.log("first bookmark:", rt.UTF16ToString(titleBuf));
}

// Color scheme render via _Start
const schemePtr = rt.wasmExports.malloc(16);
const view = new DataView(rt.HEAPU8.buffer);
view.setUint32(schemePtr + 0, 0xff282828, true); // path fill dark
view.setUint32(schemePtr + 4, 0xffdcdcdc, true); // path stroke
view.setUint32(schemePtr + 8, 0xffdcdcdc, true); // text fill
view.setUint32(schemePtr + 12, 0xff282828, true); // text stroke
const bmp2 = mod.FPDFBitmap_Create(pxW, pxH, 1);
const t2 = performance.now();
const progress = mod.FPDF_RenderPageBitmapWithColorScheme_Start(
  bmp2,
  page,
  0,
  0,
  pxW,
  pxH,
  0,
  0,
  schemePtr,
  0,
);
const t3 = performance.now();
console.log("colorscheme _Start ->", progress, "in", (t3 - t2).toFixed(2), "ms");
const buf2 = mod.FPDFBitmap_GetBuffer(bmp2);
console.log("colorscheme pixel sample:", Array.from(rt.HEAPU8.slice(buf2, buf2 + 8)));

// cleanup
mod.FPDFBitmap_Destroy(bitmap);
mod.FPDFBitmap_Destroy(bmp2);
mod.FPDFText_ClosePage(textPage);
mod.FPDF_ClosePage(page);
mod.FPDF_CloseDocument(doc);
mod.FPDF_DestroyLibrary();
console.log("done");
