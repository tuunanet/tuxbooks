import { vi } from "vitest";

/**
 * Fake of the `@/lib/pdf/pdfEngine` surface for unit tests. Test files must
 * hoist `vi.mock("@/lib/pdf/pdfEngine", ...)` themselves (vitest hoists
 * mocks above imports); this helper then builds documents to resolve with.
 */
export interface FakePdfDocument {
  numPages: number;
  getPage: ReturnType<typeof vi.fn>;
  /** Every scale passed to getViewport, in call order. */
  scales: number[];
  /** The options object of every page.render call, in call order. */
  renderOptions: Array<{ smartColors?: unknown } & Record<string, unknown>>;
  /** Resolves a render held open via `holdRenderFor`. */
  releaseRender: (pageNumber: number) => void;
  /** Page numbers whose held render task was cancelled. */
  cancelledPages: number[];
  /** Fires the engine's one-shot worker-death listeners (recovery path). */
  failWorker: () => void;
  /** Registered by the engine seam (`PdfDocument.onWorkerFailed`). */
  onWorkerFailed: ReturnType<typeof vi.fn>;
}

export interface PageSizeSpec {
  width: number;
  height: number;
}

export function makeFakePdfDocument(
  pageCount = 3,
  sizeFor: (pageNumber: number) => PageSizeSpec = () => ({ width: 612, height: 792 }),
  options: { holdRenderFor?: number[]; failOnceFor?: number[] } = {},
): FakePdfDocument {
  const scales: number[] = [];
  const renderOptions: Array<{ smartColors?: unknown } & Record<string, unknown>> = [];
  const held = new Set(options.holdRenderFor ?? []);
  const failOnce = new Set(options.failOnceFor ?? []);
  const attempts = new Map<number, number>();
  const releaseFns = new Map<number, () => void>();
  // A release can arrive before its held render registers: the canvas mounts
  // and reports its lifecycle a beat before the async effect reaches
  // page.render. Remember it so the render resolves the moment it starts
  // instead of racing the caller and hanging under slow instrumentation.
  const pendingRelease = new Set<number>();
  const cancelledPages: number[] = [];
  const workerFailureListeners: Array<() => void> = [];
  const doc: FakePdfDocument = {
    numPages: pageCount,
    getPage: vi.fn(),
    scales,
    renderOptions,
    releaseRender: (pageNumber) => {
      const release = releaseFns.get(pageNumber);
      if (release) {
        releaseFns.delete(pageNumber);
        release();
        return;
      }
      // No held render registered yet: queue the release for the next one.
      pendingRelease.add(pageNumber);
    },
    cancelledPages,
    failWorker: () => {
      for (const listener of workerFailureListeners.splice(0)) listener();
    },
    onWorkerFailed: vi.fn((callback: () => void) => {
      workerFailureListeners.push(callback);
      return () => {
        const index = workerFailureListeners.indexOf(callback);
        if (index !== -1) workerFailureListeners.splice(index, 1);
      };
    }),
  };
  const pages = new Map();
  doc.getPage.mockImplementation(async (number: number) => {
    if (!pages.has(number)) {
      const size = sizeFor(number);
      pages.set(number, {
        getViewport: vi.fn(({ scale }: { scale: number }) => {
          scales.push(scale);
          return { width: size.width * scale, height: size.height * scale };
        }),
        render: vi.fn((renderCall: { smartColors?: unknown } & Record<string, unknown>) => {
          renderOptions.push(renderCall);
          attempts.set(number, (attempts.get(number) ?? 0) + 1);
          if (failOnce.has(number) && (attempts.get(number) ?? 0) === 1) {
            return {
              promise: Promise.reject(new Error(`render boom ${number}`)),
              cancel: vi.fn(),
            };
          }
          if (held.has(number)) {
            if (pendingRelease.delete(number)) {
              return {
                promise: Promise.resolve(),
                cancel: vi.fn(() => cancelledPages.push(number)),
              };
            }
            return {
              promise: new Promise<void>((resolve) => releaseFns.set(number, resolve)),
              cancel: vi.fn(() => cancelledPages.push(number)),
            };
          }
          return { promise: Promise.resolve(), cancel: vi.fn() };
        }),
      });
    }
    return pages.get(number);
  });
  return doc;
}
