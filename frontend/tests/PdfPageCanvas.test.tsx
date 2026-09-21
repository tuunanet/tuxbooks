import { useEffect, useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/pdf/pdfEngine", () => ({
  isRenderingCancelled: vi.fn(() => false),
}));

import { PdfPageCanvas } from "@/components/reader/pdf/PdfPageCanvas";
import { makeFakePdfDocument } from "./mocks/pdfEngine";

const fakeCtx = {
  clearRect: vi.fn(),
  drawImage: vi.fn(),
};

describe("PdfPageCanvas color-mode reset (issue #67 follow-up)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      fakeCtx as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears the canvas when the render variant changes, not on geometry changes", async () => {
    const doc = makeFakePdfDocument(1, undefined, { holdRenderFor: [1] });

    const view = render(
      <PdfPageCanvas
        document={doc as never}
        pageNumber={1}
        width={100}
        height={129}
        scale={1}
        renderVariant="smart"
        smartColors={{ background: [0.063, 0.063, 0.075], text: [0.894, 0.894, 0.906] }}
      />,
    );

    // The first run starts the smart render; no reset has happened.
    expect(fakeCtx.clearRect).not.toHaveBeenCalled();

    // Switching the color mode must clear the stale wrong-mode bitmap so
    // the wrapper's themed placeholder shows while the new render is in
    // flight, and submit a fresh render request.
    const rendersBefore = doc.renderOptions.length;
    view.rerender(
      <PdfPageCanvas
        document={doc as never}
        pageNumber={1}
        width={100}
        height={129}
        scale={1}
        renderVariant="original"
      />,
    );
    expect(fakeCtx.clearRect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(doc.renderOptions.length).toBeGreaterThan(rendersBefore));

    // A geometry-only change keeps the old pixels visible (atomic-blit
    // contract) — no additional reset.
    view.rerender(
      <PdfPageCanvas
        document={doc as never}
        pageNumber={1}
        width={200}
        height={258}
        scale={1}
        renderVariant="original"
      />,
    );
    expect(fakeCtx.clearRect).toHaveBeenCalledTimes(1);
  });
});

describe("PdfPageCanvas scale-and-swap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      fakeCtx as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Render one page to a level of completion the caller controls. */
  function renderPage(doc: ReturnType<typeof makeFakePdfDocument>) {
    return render(
      <PdfPageCanvas document={doc as never} pageNumber={1} width={100} height={129} scale={1} />,
    );
  }

  it("keeps the previous bitmap scaled through a scale change, then swaps in the new one", async () => {
    const doc = makeFakePdfDocument(1, undefined, { holdRenderFor: [1] });
    const view = renderPage(doc);
    const canvas = screen.getByTestId("pdf-canvas");

    // Complete the first render at scale 1.
    await waitFor(() => expect(doc.renderOptions.length).toBe(1));
    doc.releaseRender(1);
    await waitFor(() => expect(canvas).toHaveAttribute("data-pdf-render-quality", "final"));
    expect(canvas.style.transform).toBe("");

    // Scale change while the new render is held: the previous bitmap is
    // immediately drawn under a transform sized to the new box. The visible
    // surface is never blank (a drawable bitmap is present throughout).
    view.rerender(
      <PdfPageCanvas document={doc as never} pageNumber={1} width={200} height={258} scale={2} />,
    );
    expect(canvas).toHaveAttribute("data-pdf-render-quality", "scaled");
    expect(canvas.style.transform).toBe("scale(2, 2)");
    expect(fakeCtx.drawImage).toHaveBeenCalledTimes(1); // still the first buffer

    // The new-scale raster resolves; the atomic blit replaces the scaled
    // bitmap and clears the transform.
    await waitFor(() => expect(doc.renderOptions.length).toBe(2));
    doc.releaseRender(1);
    await waitFor(() => expect(canvas).toHaveAttribute("data-pdf-render-quality", "final"));
    expect(canvas.style.transform).toBe("");
    expect(fakeCtx.drawImage).toHaveBeenCalledTimes(2);
    expect(canvas.getAttribute("width")).toBe(String(Math.floor(612 * 2)));
  });

  it("presents the scaled bitmap in the layout phase, before the resized wrapper can paint uncovered", async () => {
    const doc = makeFakePdfDocument(1, undefined, { holdRenderFor: [1] });
    const observed: string[] = [];

    // A parent layout effect runs after a child's layout effects but before
    // the browser paints, so the canvas state read here is what the first
    // paintable frame contains. The scaled bitmap must already cover the
    // wrapper React just resized; as a passive effect it did not, and the
    // frame in between flashed the page placeholder (the zoom white flash).
    function Harness({ scale }: { scale: number }) {
      const mounted = useRef(false);
      useLayoutEffect(() => {
        if (!mounted.current) return;
        observed.push(
          document.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas"]')?.style
            .transform ?? "missing",
        );
      });
      useEffect(() => {
        mounted.current = true;
      });
      return (
        <PdfPageCanvas
          document={doc as never}
          pageNumber={1}
          width={100 * scale}
          height={129 * scale}
          scale={scale}
        />
      );
    }

    const view = render(<Harness scale={1} />);
    await waitFor(() => expect(doc.renderOptions.length).toBe(1));
    doc.releaseRender(1);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-render-quality", "final"),
    );

    observed.length = 0;
    view.rerender(<Harness scale={2} />);

    expect(observed.at(-1)).toBe("scale(2, 2)");
  });

  it("scales the previous full-page bitmap over the page box when zoom crosses into region mode", async () => {
    // The renderer reads devicePixelRatio once per render; force a HiDPI
    // display so the whole-page ratio caps below it and region mode engages.
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    const doc = makeFakePdfDocument(1, undefined, { holdRenderFor: [1] });
    const view = renderPage(doc);
    const canvas = screen.getByTestId("pdf-canvas");
    await waitFor(() => expect(doc.renderOptions.length).toBe(1));
    doc.releaseRender(1);
    await waitFor(() => expect(canvas).toHaveAttribute("data-pdf-render-quality", "final"));

    // A zoom deep enough that the whole-page buffer would drop below device
    // resolution, with a viewport region supplied: region mode engages and the
    // old full-page pixels must cover the *page* box, not the region rect (the
    // wrapper is now scrolled far from the page origin).
    view.rerender(
      <PdfPageCanvas
        document={doc as never}
        pageNumber={1}
        width={3000}
        height={3000}
        scale={30}
        region={{ left: 100, top: 200, width: 2000, height: 2000 }}
      />,
    );

    expect(canvas).toHaveAttribute("data-pdf-render-quality", "scaled");
    expect(canvas.style.left).toBe("0px");
    expect(canvas.style.top).toBe("0px");
    expect(canvas.style.transform).toBe(`scale(30, ${3000 / 129})`);
  });

  it("keeps a display-only canvas scaled without starting a new raster", async () => {
    const doc = makeFakePdfDocument(1);
    const view = renderPage(doc);
    const canvas = screen.getByTestId("pdf-canvas");
    await waitFor(() => expect(canvas).toHaveAttribute("data-pdf-render-quality", "final"));
    const requestsAfterFirst = doc.getPage.mock.calls.length;

    view.rerender(
      <PdfPageCanvas
        document={doc as never}
        pageNumber={1}
        width={200}
        height={258}
        scale={2}
        renderEnabled={false}
      />,
    );

    expect(canvas).toHaveAttribute("data-pdf-render-quality", "scaled");
    expect(canvas.style.transform).toBe("scale(2, 2)");
    // Wait out the render-settle window: a display-only canvas must not ask
    // the engine for a page it is not budgeted to rasterize.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(doc.getPage.mock.calls.length).toBe(requestsAfterFirst);
    expect(canvas).toHaveAttribute("data-pdf-render-quality", "scaled");
  });
});
