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
}

export function makeFakePdfDocument(pageCount = 3): FakePdfDocument {
  const scales: number[] = [];
  const doc: FakePdfDocument = {
    numPages: pageCount,
    getPage: vi.fn(),
    scales,
  };
  const pages = new Map();
  doc.getPage.mockImplementation(async (number: number) => {
    if (!pages.has(number)) {
      pages.set(number, {
        getViewport: vi.fn(({ scale }: { scale: number }) => {
          scales.push(scale);
          return { width: Math.floor(612 * scale), height: Math.floor(792 * scale) };
        }),
        render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      });
    }
    return pages.get(number);
  });
  return doc;
}
