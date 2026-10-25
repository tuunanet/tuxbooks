import { describe, expect, it, vi } from "vite-plus/test";
import { act, renderHook, waitFor } from "@testing-library/react";

import { usePdfGeometry } from "@/components/reader/pdf/hooks/usePdfGeometry";
import type { PdfDocument } from "@/lib/pdf/pdfEngine";

/**
 * Page geometry for the continuous layout, focused on the eager
 * full-document sweep (the scrollbar fix, tuxbooks-x27.5): waves, the
 * over-limit lazy fallback, document-switch
 * cancellation, and carrying on past failed waves. Reader-level
 * integration lives in PdfReader.test.tsx.
 */

/** Distinct per-page real size, so estimates and corrections never agree. */
function sizeFor(pageNumber: number): { width: number; height: number } {
  return { width: 500 + pageNumber, height: 700 + pageNumber };
}

interface EnginePage {
  getViewport(options: { scale: number }): { width: number; height: number };
}

function enginePage(pageNumber: number, offset = 0): EnginePage {
  return {
    getViewport: ({ scale }) => ({
      width: (sizeFor(pageNumber).width + offset) * scale,
      height: (sizeFor(pageNumber).height + offset) * scale,
    }),
  };
}

/** The stored geometry entry for a real measured page. */
function storedSize(pageNumber: number): { pageNumber: number; width: number; height: number } {
  return { pageNumber, ...sizeFor(pageNumber) };
}

interface FakeSweepDocument {
  doc: PdfDocument;
  getPage: ReturnType<typeof vi.fn>;
}

function makeSweepDocument(pageCount: number): FakeSweepDocument {
  const getPage = vi.fn(async (pageNumber: number) => enginePage(pageNumber));
  return { doc: { numPages: pageCount, getPage } as unknown as PdfDocument, getPage };
}

interface HookProps {
  doc: PdfDocument;
  pageCount: number;
  firstPainted: boolean;
}

function renderGeometry(props: HookProps) {
  return renderHook(
    ({ doc, pageCount, firstPainted }: HookProps) => usePdfGeometry(doc, pageCount, firstPainted),
    { initialProps: props },
  );
}

describe("usePdfGeometry eager sweep", () => {
  it("sweeps every page in waves once first paint lands", async () => {
    // 600 pages crosses two wave boundaries (250 per wave) and ends with a
    // partial third wave, so the wave loop is exercised for real.
    const { doc, getPage } = makeSweepDocument(600);
    const { result, rerender } = renderGeometry({ doc, pageCount: 600, firstPainted: false });

    // Before first paint only the opening sample (1, 2, 600) is measured;
    // the rest hold the sampled-median estimate.
    await waitFor(() => expect(result.current.sizes).not.toBeNull());
    expect(getPage.mock.calls.map(([page]) => page).sort((a, b) => a - b)).toEqual([1, 2, 600]);
    const estimate = result.current.sizes![299];
    expect(estimate?.pageNumber).toBe(300);
    expect(estimate).not.toEqual(storedSize(300));

    await act(async () => {
      rerender({ doc, pageCount: 600, firstPainted: true });
    });
    await waitFor(() => expect(result.current.sizes![299]).toEqual(storedSize(300)));
    // The sweep measured every page exactly once; the sample pages were
    // skipped as already measured.
    const measured = getPage.mock.calls.map(([page]) => page).sort((a, b) => a - b);
    expect(measured).toEqual(Array.from({ length: 600 }, (_, i) => i + 1));
  });

  it("stays lazy above the eager page limit", async () => {
    const { doc, getPage } = makeSweepDocument(5001);
    const { result, rerender } = renderGeometry({ doc, pageCount: 5001, firstPainted: false });
    await waitFor(() => expect(result.current.sizes).not.toBeNull());

    await act(async () => {
      rerender({ doc, pageCount: 5001, firstPainted: true });
    });
    await act(async () => {});
    // First paint alone sweeps nothing: only the opening sample ran.
    expect(getPage.mock.calls.map(([page]) => page).sort((a, b) => a - b)).toEqual([1, 2, 5001]);

    // The on-approach path is the correction mechanism for these documents.
    act(() => {
      result.current.measurePages([3000]);
    });
    await waitFor(() => expect(result.current.sizes![2999]).toEqual(storedSize(3000)));
    expect(getPage).toHaveBeenCalledWith(3000);
  });

  it("drops a superseded document's in-flight sweep", async () => {
    // A's waves park inside getPage so the switch happens mid-sweep; A's
    // real sizes carry an offset so a late A commit is distinguishable
    // from B's.
    const gates: Array<() => void> = [];
    const getPageA = vi.fn(async (pageNumber: number) => {
      // Hold the sweep's pages, never the opening sample (1, 2, 300).
      if (pageNumber > 2 && pageNumber < 300) {
        await new Promise<void>((resolve) => gates.push(resolve));
      }
      return enginePage(pageNumber, 1000);
    });
    const docA = { numPages: 300, getPage: getPageA } as unknown as PdfDocument;
    const { doc: docB } = makeSweepDocument(300);

    // Production ordering: the sample lands first, then first paint starts
    // the sweep.
    const { result, rerender } = renderGeometry({ doc: docA, pageCount: 300, firstPainted: false });
    await waitFor(() => expect(result.current.sizes).not.toBeNull());
    await act(async () => {
      rerender({ doc: docA, pageCount: 300, firstPainted: true });
    });
    expect(gates.length).toBeGreaterThan(0);

    // Switch documents while A's first wave is held: the cancelled sweep
    // must neither keep measuring nor commit into B's geometry.
    await act(async () => {
      rerender({ doc: docB, pageCount: 300, firstPainted: true });
    });
    for (const resolve of gates.splice(0)) resolve();
    await act(async () => {});
    // B's sweep ran: a body page carries B's real size, never A's offset one.
    await waitFor(() => expect(result.current.sizes![199]).toEqual(storedSize(200)));
    expect(result.current.sizes![199]?.width).toBe(sizeFor(200).width);
  });

  it("carries on past a failed wave; failed pages stay retryable", async () => {
    // The opening sample (1, 2, 260) succeeds; wave 1 (pages 3..250) fails,
    // wave 2 (251..259) succeeds. A failed wave must not stop the sweep:
    // the surviving pages still get measured, failed pages stay unmeasured
    // for the lazy on-approach path to retry.
    const failing = new Set(Array.from({ length: 248 }, (_, i) => i + 3));
    const getPage = vi.fn(async (pageNumber: number) => {
      if (failing.has(pageNumber)) throw new Error(`page ${pageNumber} unavailable`);
      return enginePage(pageNumber);
    });
    const doc = { numPages: 260, getPage } as unknown as PdfDocument;

    // Production ordering: the sample lands first, then first paint starts
    // the sweep.
    const { result, rerender } = renderGeometry({ doc, pageCount: 260, firstPainted: false });
    await waitFor(() => expect(result.current.sizes).not.toBeNull());
    await act(async () => {
      rerender({ doc, pageCount: 260, firstPainted: true });
    });
    // Wave 2 landed despite wave 1 failing outright.
    await waitFor(() => expect(result.current.sizes![250]).toEqual(storedSize(251)));
    // A wave-1 page stays at its estimate: unmeasured, not failed forever.
    expect(result.current.sizes![198]).not.toEqual(storedSize(199));
    // The sweep attempted every wave (no abort), including wave 2's pages.
    const attempted = getPage.mock.calls.map(([page]) => page);
    expect(attempted.filter((page) => page > 250 && page < 260)).toHaveLength(9);

    // The lazy path retries a failed page once the engine recovers.
    failing.delete(199);
    act(() => {
      result.current.measurePages([199]);
    });
    await waitFor(() => expect(result.current.sizes![198]).toEqual(storedSize(199)));
  });
});
