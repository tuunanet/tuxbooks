import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@/lib/pdf/pdfEngine", async () => {
  const { findPageMatches } = await import("@/lib/pdf/pdfSearch");
  return {
    findPageMatches,
    getPdfPageText: vi.fn(async () => ""),
  };
});

import { getPdfPageText, type PdfDocument } from "@/lib/pdf/pdfEngine";
import { usePdfSearch } from "@/components/reader/pdf/hooks/usePdfSearch";

/**
 * In-book search contract (tuxbooks-koe.8): the engine-agnostic hook streams
 * one group per page and stops once the total reaches the 500-match cap, so a
 * pathological document cannot flood the drawer. The text itself comes through
 * the seam (`getPdfPageText`), which the adapter test proves routes through
 * PDFium's structured text lines.
 */

function makeDocument(numPages: number): PdfDocument {
  return { numPages } as PdfDocument;
}

afterEach(() => {
  vi.mocked(getPdfPageText).mockReset();
});

describe("usePdfSearch", () => {
  it("streams one match group per page and reports completion", async () => {
    vi.mocked(getPdfPageText).mockImplementation(async (_document, page) =>
      page === 1 ? "alpha beta gamma" : "delta beta epsilon",
    );
    const groups: Array<{ label: string; matches: unknown[] }> = [];
    let done = false;

    const { result } = renderHook(() =>
      usePdfSearch({
        document: makeDocument(2),
        bookId: 7,
        onGroup: (_bookId, group) => groups.push(group as never),
        onDone: () => {
          done = true;
        },
      }),
    );

    act(() => result.current.run("beta"));
    await waitFor(() => expect(done).toBe(true));

    expect(groups.map((group) => group.label)).toEqual(["Page 1", "Page 2"]);
    expect(groups[0]?.matches).toHaveLength(1);
    expect(groups[1]?.matches).toHaveLength(1);
  });

  it("stops at the 500-match cap instead of walking every page", async () => {
    // 250 non-overlapping matches per page, so the cap lands exactly on the
    // second page: pages 3 and 4 are never extracted.
    vi.mocked(getPdfPageText).mockImplementation(async () => Array(250).fill("a").join(" "));
    const groups: Array<{ label: string; matches: unknown[] }> = [];
    let done = false;

    const { result } = renderHook(() =>
      usePdfSearch({
        document: makeDocument(4),
        bookId: 7,
        onGroup: (_bookId, group) => groups.push(group as never),
        onDone: () => {
          done = true;
        },
      }),
    );

    act(() => result.current.run("a"));
    await waitFor(() => expect(done).toBe(true));

    const total = groups.reduce((sum, group) => sum + group.matches.length, 0);
    expect(total).toBe(500);
    expect(groups.map((group) => group.label)).toEqual(["Page 1", "Page 2"]);
    expect(vi.mocked(getPdfPageText)).toHaveBeenCalledTimes(2);
  });
});
