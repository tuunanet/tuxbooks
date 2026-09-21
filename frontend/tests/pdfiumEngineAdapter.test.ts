import { afterEach, describe, expect, test, vi } from "vitest";

import { PDF_ENGINE_STORAGE_KEY } from "@/lib/pdf/pdfEngineFlag";

/**
 * The PDFium main-thread adapter (tuxbooks-koe.5, .7) against a fake worker:
 * the seam shape (open → page sizes → whole-page render → text lines), the
 * transform ratio, the reserved capabilities, and the flag dispatch between
 * engines. The real WASM load is covered by pdfiumEngine.node.test.ts and the
 * engine's E2E smoke; this pins the main-thread contract cheaply.
 */

interface RenderRequest {
  page: number;
  width: number;
  height: number;
  clip?: number[];
}

const workers: FakeWorker[] = [];

class FakeWorker {
  readonly url: string;
  terminated = false;
  posted: number[] = [];
  renders: RenderRequest[] = [];
  texts: { page: number }[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
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
        this.texts.push({ page });
        // Page 3 has no usable text: the reader must degrade to no layer.
        const lines =
          page === 3 ? [] : [{ text: `line ${page}`, x: 10, y: 20, w: 100, h: 30, size: 24 }];
        this.respond({ id, ok: true, result: { lines } });
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

const { openPdfDocumentFromBook, renderPdfTextLayer } = await import("@/lib/pdf/pdfEngine");

afterEach(() => {
  workers.length = 0;
  window.localStorage.clear();
});

describe("PDFium adapter", () => {
  test("opens range-backed, reports page sizes, and rasters with the transform ratio", async () => {
    window.localStorage.setItem(PDF_ENGINE_STORAGE_KEY, "pdfium");
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    expect(workers).toHaveLength(1);
    expect(workers[0]!.url).toContain("pdfiumWorker");
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
    window.localStorage.setItem(PDF_ENGINE_STORAGE_KEY, "pdfium");
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

  test("reserves the outline, so the reader opens without it", async () => {
    window.localStorage.setItem(PDF_ENGINE_STORAGE_KEY, "pdfium");
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    await expect(pdf.getOutline()).resolves.toBeNull();
    await pdf.destroy();
  });

  test("requests text from the worker, caches it, and shapes the lines", async () => {
    window.localStorage.setItem(PDF_ENGINE_STORAGE_KEY, "pdfium");
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    await expect(pdf.getTextLines(2)).resolves.toEqual([
      { text: "line 2", x: 10, y: 20, w: 100, h: 30, size: 24 },
    ]);
    expect(workers[0]!.texts).toEqual([{ page: 2 }]);

    // The document caches per page, so the text layer and search share one
    // extraction instead of re-requesting.
    await pdf.getTextLines(2);
    expect(workers[0]!.texts).toEqual([{ page: 2 }]);

    // The seam's text-layer renderer turns those lines into positioned,
    // transparent spans at the requested scale, unchanged by the engine swap.
    const container = document.createElement("div");
    await renderPdfTextLayer(pdf, 2, container, 2);
    const span = container.querySelector("span")!;
    expect(span.textContent).toBe("line 2");
    expect(span.style.left).toBe("20px");
    expect(span.style.top).toBe("40px");
    expect(span.style.width).toBe("200px");
    expect(span.style.height).toBe("60px");
    expect(span.style.fontSize).toBe("48px");

    await pdf.destroy();
  });

  test("a page with no usable text degrades to no text layer without error", async () => {
    window.localStorage.setItem(PDF_ENGINE_STORAGE_KEY, "pdfium");
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    await expect(pdf.getTextLines(3)).resolves.toEqual([]);
    const container = document.createElement("div");
    await renderPdfTextLayer(pdf, 3, container, 1);
    expect(container.childElementCount).toBe(0);

    await pdf.destroy();
  });

  test("flag off keeps the MuPDF engine selected", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");
    expect(workers).toHaveLength(1);
    expect(workers[0]!.url).toContain("mupdfWorker");
    await pdf.destroy();
  });
});
