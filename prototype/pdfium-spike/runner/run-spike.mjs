// Throwaway Phase 0 spike runner (tuxbooks-koe.2): bundles the worker, serves it
// over HTTP with byte-range support, runs it in a real Web Worker under
// Chromium, and writes the evidence report. Never merged into the product.

import { createServer } from "node:http";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = join(root, "dist");
const browserDir = join(root, "browser");
const reportsDir = join(root, "reports");

const DEFAULT_PDF =
  process.env.SPIKE_PDF ??
  "/home/tuunanet/git/tuunanet/tuxbooks/tests/fixtures/books/EBooks/Papers/GeoTopo.pdf";

mkdirSync(dist, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

// 1. Bundle the worker. platform=browser makes esbuild pick the package's
//    `browser` export condition (index.browser.js) automatically.
const esbuildBin = join(root, "node_modules", ".bin", "esbuild");
console.error("[spike] bundling worker");
const bundle = spawnSync(
  esbuildBin,
  [
    join(browserDir, "worker.js"),
    "--bundle",
    "--format=iife",
    "--platform=browser",
    `--outfile=${join(dist, "worker.js")}`,
  ],
  { encoding: "utf8" },
);
if (bundle.status !== 0) {
  console.error(bundle.stdout, bundle.stderr);
  process.exit(1);
}
console.error("[spike] worker bundled");

// 2. Stage the wasm beside the worker.
const wasmSrc = join(root, "node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm");
copyFileSync(wasmSrc, join(dist, "pdfium.wasm"));
const wasmBytes = statSync(wasmSrc).size;
const workerBytes = statSync(join(dist, "worker.js")).size;

// 3. HTTP server with range support and byte accounting.
const served = { requests: 0, bytes: 0 };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let filePath;
  if (url.pathname === "/" || url.pathname === "/index.html")
    filePath = join(browserDir, "index.html");
  else if (url.pathname === "/worker.js") filePath = join(dist, "worker.js");
  else if (url.pathname === "/pdfium.wasm") filePath = join(dist, "pdfium.wasm");
  else if (url.pathname === "/book.pdf") filePath = DEFAULT_PDF;
  else {
    res.writeHead(404).end("not found");
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end("missing " + filePath);
    return;
  }
  const total = statSync(filePath).size;
  const range = req.headers.range;
  console.error(`[req] ${req.method} ${url.pathname}${range ? " " + range : ""}`);
  if (url.pathname === "/book.pdf") served.requests++;
  if (range && url.pathname === "/book.pdf") {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : total - 1;
    const chunk = Math.min(end, total - 1) - start + 1;
    served.bytes += chunk;
    res.writeHead(206, {
      "Content-Type": "application/pdf",
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunk,
    });
    createReadStream(filePath, { start, end: Math.min(end, total - 1) }).pipe(res);
    return;
  }
  const type =
    extname(filePath) === ".wasm"
      ? "application/wasm"
      : extname(filePath) === ".html"
        ? "text/html"
        : "application/javascript";
  res.writeHead(200, { "Content-Type": type, "Content-Length": total, "Accept-Ranges": "bytes" });
  createReadStream(filePath).pipe(res);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.error(`[spike] server on ${base}`);

// 4. Run in a real Web Worker under Chromium.
const browser = await chromium.launch({
  executablePath: process.env.SPIKE_CHROMIUM ?? "/usr/bin/chromium-browser",
  args: ["--no-sandbox"],
});
console.error("[spike] chromium launched");
const page = await browser.newPage();
page.on("console", (m) => process.stderr.write(`[page] ${m.text()}\n`));
page.on("pageerror", (e) => process.stderr.write(`[pageerror] ${e.message}\n`));
page.setDefaultTimeout(120000);
await page.goto(base + "/");
console.error("[spike] page ready, running worker");
const fileLength = statSync(DEFAULT_PDF).size;
const pdfUrl = `${base}/book.pdf`;

const report = await page.evaluate(
  async ({ pdfUrl, length, label, needle }) => {
    return await window.__spike({ pdfUrl, length, label: { text: label, needle } });
  },
  {
    pdfUrl,
    length: fileLength,
    label: process.env.SPIKE_LABEL ?? "GeoTopo.pdf (117pp, vector+text)",
    needle: process.env.SPIKE_NEEDLE ?? "Geometrie",
  },
);

await browser.close();
server.close();

report.package = {
  name: "@embedpdf/pdfium",
  version: "2.15.0",
  license: "MIT",
  wasmBytes,
  workerBundleBytes: workerBytes,
  note: "browser export condition (dist/index.browser.js) bundled as a classic Web Worker",
};
report.server = served;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(reportsDir, `spike-${stamp}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));
writeFileSync(join(reportsDir, "latest.json"), JSON.stringify(report, null, 2));

console.log(JSON.stringify(report, null, 2));
console.error(`\nreport written to ${outFile}`);
