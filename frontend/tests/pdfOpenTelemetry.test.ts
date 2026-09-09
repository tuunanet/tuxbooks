import { describe, expect, it } from "vitest";
import { pdfOpenState, pdfOpenTiming } from "@/components/reader/pdf/pdfOpenTelemetry";

describe("pdfOpenState", () => {
  it("walks the open path in order", () => {
    const base = {
      status: "loading",
      hasDocument: false,
      layoutReady: false,
      restored: false,
      hasFirstPaint: false,
    } as const;
    expect(pdfOpenState(base)).toBe("document-opening");
    expect(pdfOpenState({ ...base, status: "ready", hasDocument: true })).toBe("document-ready");
    expect(pdfOpenState({ ...base, status: "ready", hasDocument: true, layoutReady: true })).toBe(
      "geometry-ready",
    );
    expect(
      pdfOpenState({
        ...base,
        status: "ready",
        hasDocument: true,
        layoutReady: true,
        restored: true,
      }),
    ).toBe("first-render-start");
    expect(
      pdfOpenState({
        ...base,
        status: "ready",
        hasDocument: true,
        layoutReady: true,
        restored: true,
        hasFirstPaint: true,
      }),
    ).toBe("interactive");
  });

  it("maps an open failure back to the created stage", () => {
    expect(
      pdfOpenState({
        status: "error",
        hasDocument: false,
        layoutReady: false,
        restored: false,
        hasFirstPaint: false,
      }),
    ).toBe("created");
  });
});

describe("pdfOpenTiming", () => {
  it("omits segments that have not happened yet", () => {
    expect(
      pdfOpenTiming({ bytes: "range", openMs: null, firstPaintMs: null, interactiveMs: null }),
    ).toBe("bytes=range");
    expect(
      pdfOpenTiming({ bytes: "range", openMs: 142.6, firstPaintMs: null, interactiveMs: null }),
    ).toBe("bytes=range;open=143");
  });

  it("joins every measured segment in order", () => {
    expect(
      pdfOpenTiming({ bytes: "range", openMs: 142.6, firstPaintMs: 410.4, interactiveMs: 452.9 }),
    ).toBe("bytes=range;open=143;firstPaint=410;interactive=453");
  });
});
