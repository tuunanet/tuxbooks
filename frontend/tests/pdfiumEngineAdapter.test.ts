import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { findPageMatches } from "@/lib/pdf/pdfSearch";

/**
 * The PDFium main-thread adapter (tuxbooks-koe.5, .7, .8) against a fake
 * worker: the seam shape (open → page sizes → whole-page render → text lines →
 * outline), the transform ratio, and outline/search routing. The real WASM
 * load is covered by pdfiumEngine.node.test.ts and the engine's E2E smoke;
 * this pins the main-thread contract cheaply.
 */

interface RenderRequest {
  page: number;
  width: number;
  height: number;
  clip?: number[];
  colorScheme?: {
    pathFill: number;
    pathStroke: number;
    textFill: number;
    textStroke: number;
  };
}

const workers: FakeWorker[] = [];

class FakeWorker {
  terminated = false;
  posted: number[] = [];
  renders: RenderRequest[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;

  constructor(url: string) {
    // The fake implements Worker's constructor signature; no assertion
    // reads the URL (the wiring asserts were slimmed away).
    void url;
    workers.push(this);
  }

  postMessage(message: { id: number; method: string; params?: unknown }): void {
    this.posted.push(message.id);
    queueMicrotask(() => {
      if (this.terminated) return;
      const { id, method, params } = message;
      if (method === "open") this.respond({ id, ok: true, result: { pageCount: 5 } });
      else if (method === "pageSize") {
        this.respond({ id, ok: true, result: { width: 200, height: 300 } });
      } else if (method === "render") {
        this.renders.push(params as RenderRequest);
        this.respond({ id, ok: true, result: { bitmap: { close: vi.fn() } } });
      } else if (method === "text") {
        const page = (params as { page: number }).page;
        // Page 3 has no usable text: the reader must degrade to no layer.
        // Page 4 reports a lying font size (a degenerate text matrix: the
        // char boxes stand 30 units while GetFontSize says 1.2), the shape
        // that collapsed PDF mouse selection when the text layer trusted it.
        const lines =
          page === 3
            ? []
            : page === 4
              ? [{ text: "degenerate", x: 10, y: 20, w: 100, h: 30, size: 1.2 }]
              : [{ text: `line ${page}`, x: 10, y: 20, w: 100, h: 30, size: 24 }];
        this.respond({ id, ok: true, result: { lines } });
      } else if (method === "outline") {
        // The raw seam shape: 0-based pages, an external link without a page.
        this.respond({
          id,
          ok: true,
          result: {
            items: [
              {
                title: "Part One",
                page: 0,
                items: [
                  { title: "Chapter 1", page: 2, items: [] },
                  { title: "Website", page: null, items: [] },
                ],
              },
            ],
          },
        });
      } else this.respond({ id, ok: true, result: {} });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  private respond(data: unknown): void {
    this.onmessage?.({ data });
  }
}

vi.stubGlobal("Worker", FakeWorker);

const { openPdfDocumentFromBook, getPdfOutline, getPdfPageText, renderPdfTextLayer } =
  await import("@/lib/pdf/pdfEngine");

afterEach(() => {
  workers.length = 0;
  window.localStorage.clear();
});

describe("PDFium adapter", () => {
  test("opens a document, reports page sizes, and rasters with the transform ratio", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    expect(pdf.numPages).toBe(5);

    const page = await pdf.getPage(2);
    expect(page.getViewport({ scale: 2 })).toEqual({ width: 400, height: 600 });

    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 300;
    await page.render({
      canvas,
      viewport: { width: 100, height: 150 },
      transform: [2, 0, 0, 2, 0, 0],
    }).promise;
    expect(workers[0]!.renders).toEqual([{ page: 2, width: 200, height: 300 }]);

    await pdf.destroy();
    expect(workers[0]!.terminated).toBe(true);
  });

  test("renders a clipped region in page units at the transform ratio", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");
    const page = await pdf.getPage(1);
    const canvas = document.createElement("canvas");
    canvas.width = 60;
    canvas.height = 80;

    await page.render({
      canvas,
      viewport: { width: 100, height: 150 },
      transform: [2, 0, 0, 2, 0, 0],
      region: { x: 10, y: 20, width: 30, height: 40 },
    }).promise;

    // Region buffer is region-sized at the ratio (30×40 CSS × 2), and the
    // clip converts CSS to page units through the page-units-per-CSS ratio
    // (200 page units / 100 CSS = 2).
    expect(workers[0]!.renders).toEqual([
      { page: 1, width: 60, height: 80, clip: [20, 40, 60, 80] },
    ]);
    await pdf.destroy();
  });

  test("maps the dark palette to the colour scheme on the render request", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");
    const page = await pdf.getPage(1);
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 300;

    // The seam passes the reader's `SmartPalette`; the adapter converts it to
    // PDFium's category colour scheme before it crosses to the worker, so the
    // worker payload carries plain 32-bit colours (tuxbooks-koe.9).
    await page.render({
      canvas,
      viewport: { width: 100, height: 150 },
      transform: [2, 0, 0, 2, 0, 0],
      smartColors: { background: [0x10 / 255, 0x10 / 255, 0x13 / 255], text: [1, 1, 1] },
    }).promise;
    expect(workers[0]!.renders[0]?.colorScheme).toEqual({
      pathFill: 0xff101013,
      pathStroke: 0xffffffff,
      textFill: 0xffffffff,
      textStroke: 0xff101013,
    });

    // Without a palette (default, paper via CSS tint, filter modes) the
    // request carries no colour scheme.
    await page.render({ canvas, viewport: { width: 100, height: 150 } }).promise;
    expect(workers[0]!.renders[1]?.colorScheme).toBeUndefined();

    await pdf.destroy();
  });

  test("routes outline and search through the worker and shapes the results", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    // Outline: the worker walks PDFium's bookmarks and returns the raw tree;
    // the seam normalizes it to the reader's 1-based page locators.
    await expect(getPdfOutline(pdf)).resolves.toEqual([
      {
        title: "Part One",
        page: 1,
        items: [
          { title: "Chapter 1", page: 3, items: [] },
          { title: "Website", page: null, items: [] },
        ],
      },
    ]);

    // Search: page text comes from the same structured text lines the text
    // layer uses, assembled and matched case-insensitively by the pure helpers.
    const pageText = await getPdfPageText(pdf, 2);
    expect(pageText).toBe("line 2");
    expect(findPageMatches(pageText, "LINE")).toEqual([{ pre: "", match: "line", post: " 2" }]);

    await pdf.destroy();
  });

  test("requests text from the worker and shapes the lines", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    await expect(pdf.getTextLines(2)).resolves.toEqual([
      { text: "line 2", x: 10, y: 20, w: 100, h: 30, size: 24 },
    ]);

    // The seam's text-layer renderer turns those lines into positioned,
    // transparent spans at the requested scale. No fixed width: the box
    // shrink-wraps its run, and the width is fitted in the browser
    // (unmeasurable in jsdom). The font stays under the line box so the
    // painted selection band cannot exceed the line pitch.
    const container = document.createElement("div");
    await renderPdfTextLayer(pdf, 2, container, 2);
    const span = container.querySelector("span")!;
    expect(span.textContent).toBe("line 2");
    expect(span.style.left).toBe("20px");
    expect(span.style.top).toBe("40px");
    expect(span.style.width).toBe("");
    expect(span.style.height).toBe("60px");
    expect(span.style.lineHeight).toBe("60px");
    expect(span.style.fontSize).toBe("42px");

    await pdf.destroy();
  });

  test("a lying reported font size still sizes the span from the box", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    const container = document.createElement("div");
    await renderPdfTextLayer(pdf, 4, container, 2);
    const span = container.querySelector("span")!;
    expect(span.textContent).toBe("degenerate");
    // 1.2 (reported) x 2 would be an invisible 2.4px text run inside a
    // 60px hit box; the char box keeps selection hit-testing aligned.
    expect(span.style.fontSize).toBe("42px");

    await pdf.destroy();
  });

  test("a superseded layer's cancel keeps the live layer's spans", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    // StrictMode (dev) mounts the layer effect twice; the first build's
    // promise can resolve after the second has painted. Its cancel must
    // remove only its own spans — a container-wide clear left dev-mode
    // layers empty until a resize forced a rebuild.
    const container = document.createElement("div");
    const [first, second] = await Promise.all([
      renderPdfTextLayer(pdf, 2, container, 1),
      renderPdfTextLayer(pdf, 2, container, 1),
    ]);
    expect(container.querySelectorAll("span").length).toBe(2);

    first.cancel();
    expect(container.querySelectorAll("span").length).toBe(1);

    second.cancel();
    expect(container.querySelectorAll("span").length).toBe(0);

    await pdf.destroy();
  });

  test("a page with no usable text degrades to no text layer without error", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    await expect(pdf.getTextLines(3)).resolves.toEqual([]);
    const container = document.createElement("div");
    await renderPdfTextLayer(pdf, 3, container, 1);
    expect(container.childElementCount).toBe(0);

    await pdf.destroy();
  });
});
