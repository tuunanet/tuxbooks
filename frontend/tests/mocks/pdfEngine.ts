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
  /** Resolves a render held open via `holdRenderFor`. */
  releaseRender: (pageNumber: number) => void;
  /** Page numbers whose held render task was cancelled. */
  cancelledPages: number[];
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
  const held = new Set(options.holdRenderFor ?? []);
  const failOnce = new Set(options.failOnceFor ?? []);
  const attempts = new Map<number, number>();
  const releaseFns = new Map<number, () => void>();
  const cancelledPages: number[] = [];
  const doc: FakePdfDocument = {
    numPages: pageCount,
    getPage: vi.fn(),
    scales,
    releaseRender: (pageNumber) => releaseFns.get(pageNumber)?.(),
    cancelledPages,
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
        render: vi.fn(() => {
          attempts.set(number, (attempts.get(number) ?? 0) + 1);
          if (failOnce.has(number) && (attempts.get(number) ?? 0) === 1) {
            return {
              promise: Promise.reject(new Error(`render boom ${number}`)),
              cancel: vi.fn(),
            };
          }
          if (held.has(number)) {
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
