import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Smart Dark worker recycling (docs/PDF.md). The JS callback Device is the
 * one Smart Dark path that can corrupt MuPDF state after enough renders, so
 * the document trades its worker for a fresh one once the Smart Dark render
 * budget is spent. This drives the real engine seam against a fake worker to
 * pin the accounting and lifetime rules without a WASM build.
 */

const workers: FakeWorker[] = [];

class FakeImageBitmap {
  width = 0;
  height = 0;
  closed = false;
  close(): void {
    this.closed = true;
  }
}

class FakeWorker {
  terminated = false;
  posted = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;

  constructor() {
    workers.push(this);
  }

  postMessage(message: { id: number; method: string; params?: { width: number; height: number } }) {
    this.posted += 1;
    queueMicrotask(() => {
      if (this.terminated) return;
      const { id, method, params } = message;
      if (method === "open") this.respond({ id, ok: true, result: { pageCount: 10 } });
      else if (method === "pageSize")
        this.respond({ id, ok: true, result: { width: 100, height: 200 } });
      else if (method === "render") {
        const bitmap = new FakeImageBitmap();
        bitmap.width = params?.width ?? 0;
        bitmap.height = params?.height ?? 0;
        this.respond({
          id,
          ok: true,
          result:
            this.reportRecovered && method === "render" ? { bitmap, recovered: true } : { bitmap },
        });
      } else this.respond({ id, ok: true, result: {} });
    });
  }

  /** Next render responses carry `recovered: true` (display-list bypass). */
  reportRecovered = false;

  terminate(): void {
    this.terminated = true;
  }

  private respond(data: unknown): void {
    this.onmessage?.({ data });
  }
}

vi.stubGlobal("Worker", FakeWorker);
vi.stubGlobal("ImageBitmap", FakeImageBitmap);

const { openPdfDocumentFromBook } = await import("@/lib/pdf/pdfEngine");

const SMART = {
  background: [16, 16, 19] as [number, number, number],
  text: [228, 228, 231] as [number, number, number],
};

function renderOnce(
  pdf: Awaited<ReturnType<typeof openPdfDocumentFromBook>>,
  smartColors: typeof SMART | undefined,
): Promise<void> {
  const canvas = document.createElement("canvas");
  return pdf
    .getPage(1)
    .then(
      (page) => page.render({ canvas, viewport: { width: 100, height: 200 }, smartColors }).promise,
    );
}

afterEach(() => {
  workers.length = 0;
});

describe("Smart Dark worker recycling", () => {
  test("trades the worker for a fresh one after the render budget", async () => {
    const pdf = await openPdfDocumentFromBook(1, "pdf");
    expect(workers).toHaveLength(1);

    for (let i = 0; i < 181; i += 1) await renderOnce(pdf, SMART);

    await expect.poll(() => workers.length).toBe(2);
    await expect.poll(() => workers[0]!.terminated).toBe(true);
    expect(workers[1]!.terminated).toBe(false);

    // Rendering continues on the replacement.
    const before = workers[1]!.posted;
    await renderOnce(pdf, SMART);
    expect(workers[1]!.posted).toBeGreaterThan(before);

    await pdf.destroy();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  test("never recycles on non-smart renders", async () => {
    const pdf = await openPdfDocumentFromBook(2, "pdf");
    for (let i = 0; i < 250; i += 1) await renderOnce(pdf, undefined);
    expect(workers).toHaveLength(1);
    await pdf.destroy();
  });

  test("escapes the worker immediately when a render bypassed the display list", async () => {
    const pdf = await openPdfDocumentFromBook(3, "pdf");
    workers[0]!.reportRecovered = true;

    // One bypass render is the corruption signal: the swap must happen
    // right away, not after the 180-render budget.
    await renderOnce(pdf, SMART);
    await expect.poll(() => workers.length).toBe(2);
    await expect.poll(() => workers[0]!.terminated).toBe(true);

    // The replacement is clean and keeps serving.
    await renderOnce(pdf, SMART);
    expect(workers).toHaveLength(2);
    await pdf.destroy();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });
});
