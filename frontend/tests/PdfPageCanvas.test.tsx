import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

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
