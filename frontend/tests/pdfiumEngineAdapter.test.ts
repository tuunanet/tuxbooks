import { afterEach, describe, expect, test, vi } from "vitest";

import { PDF_ENGINE_STORAGE_KEY } from "@/lib/pdf/pdfEngineFlag";

/**
 * The PDFium main-thread adapter (tuxbooks-koe.5) against a fake worker: the
 * seam shape (open → page sizes → whole-page render), the transform ratio,
 * the reserved capabilities, and the flag dispatch between engines. The real
 * WASM load is covered by pdfiumEngine.node.test.ts and the engine's E2E
 * smoke; this pins the main-thread contract cheaply.
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

const { openPdfDocumentFromBook } = await import("@/lib/pdf/pdfEngine");

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

  test("reserves text and outline, so the reader opens without them", async () => {
    window.localStorage.setItem(PDF_ENGINE_STORAGE_KEY, "pdfium");
    const pdf = await openPdfDocumentFromBook(1, "pdf");

    await expect(pdf.getOutline()).resolves.toBeNull();
    await expect(pdf.getTextLines(1)).resolves.toEqual([]);
    await pdf.destroy();
  });

  test("flag off keeps the MuPDF engine selected", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");
    expect(workers).toHaveLength(1);
    expect(workers[0]!.url).toContain("mupdfWorker");
    await pdf.destroy();
  });
});
