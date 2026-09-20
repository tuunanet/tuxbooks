import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const wasmBinary = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
const { init } = await import("@embedpdf/pdfium");
const mod = await init({ wasmBinary });
const rt = mod.pdfium;
mod.FPDF_InitLibrary();
mod.PDFiumExt_Init();
const pdf = readFileSync(
  process.argv[2] ??
    "/home/tuunanet/git/tuunanet/tuxbooks/tests/fixtures/books/EBooks/Papers/GeoTopo.pdf",
);
const lp = rt.wasmExports.malloc(pdf.length);
rt.HEAPU8.set(pdf, lp);
const doc = mod.FPDF_LoadMemDocument(lp, pdf.length, "");
const page = mod.FPDF_LoadPage(doc, 0);
const w = Math.round(mod.FPDF_GetPageWidthF(page));
const h = Math.round(mod.FPDF_GetPageHeightF(page));
const WHITE = 0xffffffff,
  DARK = 0xff282828,
  LIGHT = 0xffdcdcdc;

function sample(bmp, label) {
  const buf = mod.FPDFBitmap_GetBuffer(bmp);
  const stride = mod.FPDFBitmap_GetStride(bmp);
  const px = rt.HEAPU8.subarray(buf, buf + stride * 40);
  // count near-white and near-dark and non-white
  let white = 0,
    dark = 0,
    other = 0;
  for (let i = 0; i < px.length; i += 4) {
    const b = px[i],
      g = px[i + 1],
      r = px[i + 2];
    if (b > 240 && g > 240 && r > 240) white++;
    else if (b < 60 && g < 60 && r < 60) dark++;
    else other++;
  }
  console.log(label, { buf, stride, white, dark, other, first: [px[0], px[1], px[2]] });
}

// 1. Plain colorscheme _Start with pause = 0
const scheme = rt.wasmExports.malloc(16);
const dv = new DataView(rt.HEAPU8.buffer);
dv.setUint32(scheme + 0, DARK, true);
dv.setUint32(scheme + 4, LIGHT, true);
dv.setUint32(scheme + 8, LIGHT, true);
dv.setUint32(scheme + 12, DARK, true);
let bmp = mod.FPDFBitmap_Create(w, h, 1);
mod.FPDFBitmap_FillRect(bmp, 0, 0, w, h, WHITE);
let ret = mod.FPDF_RenderPageBitmapWithColorScheme_Start(bmp, page, 0, 0, w, h, 0, 0, scheme, 0);
console.log("colorScheme _Start(pause=0) ret =", ret, "lastError =", mod.FPDF_GetLastError());
sample(bmp, "colorscheme pause=0");

// 2. Progressive with a real IFSDK_PAUSE whose NeedToPauseNow returns false
// struct: int version; fn* NeedToPauseNow; fn* user_cancel
const pause = rt.wasmExports.malloc(16);
const needPause = rt.addFunction(() => 0, "ii"); // (pThis) -> int
const userCancel = rt.addFunction(() => 0, "ii");
dv.setInt32(pause + 0, 1, true); // version = 1
dv.setUint32(pause + 4, needPause, true);
dv.setUint32(pause + 8, userCancel, true);
let bmp2 = mod.FPDFBitmap_Create(w, h, 1);
mod.FPDFBitmap_FillRect(bmp2, 0, 0, w, h, WHITE);
let guard = 0,
  r2;
do {
  r2 = mod.FPDF_RenderPageBitmapWithColorScheme_Start(bmp2, page, 0, 0, w, h, 0, 0, scheme, pause);
  console.log("progressive iter", guard, "->", r2);
  guard++;
} while (r2 !== 0 && guard < 10);
sample(bmp2, "colorscheme progressive");

// 3. Compare: non-scheme _Start
let bmp3 = mod.FPDFBitmap_Create(w, h, 1);
mod.FPDFBitmap_FillRect(bmp3, 0, 0, w, h, WHITE);
let r3 = mod.FPDF_RenderPageBitmap_Start(bmp3, page, 0, 0, w, h, 0, 0, pause);
console.log("plain _Start ret =", r3);
sample(bmp3, "plain _Start");

rt.removeFunction(needPause);
rt.removeFunction(userCancel);
mod.FPDF_ClosePage(page);
mod.FPDF_CloseDocument(doc);
mod.FPDF_DestroyLibrary();
