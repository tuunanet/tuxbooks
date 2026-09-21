import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addPdfZoomNote,
  clearPdfZoomLog,
  dumpPdfZoomLog,
  isPdfZoomTelemetryEnabled,
  recordPdfZoomSample,
  setPdfZoomTelemetryEnabled,
  type PdfZoomSample,
} from "@/lib/pdf/pdfZoomTelemetry";

function sample(overrides: Partial<PdfZoomSample> = {}): Omit<PdfZoomSample, "seq" | "t" | "iso"> {
  return {
    type: "zoom",
    trigger: "keyboard-step",
    zoomMode: "custom",
    zoomLevel: 2,
    scale: 2,
    scrollTop: 0,
    scrollLeft: 0,
    clientWidth: 800,
    clientHeight: 600,
    scrollWidth: 800,
    scrollHeight: 1200,
    documentTop: 0,
    documentLeft: 0,
    documentWidth: 800,
    documentHeight: 1200,
    centerScrollX: 400,
    centerScrollY: 300,
    centerLocalX: 400,
    centerLocalY: 300,
    centerPageUnitsX: 200,
    centerPageUnitsY: 150,
    anchorPage: 1,
    anchorFraction: 0.25,
    policy: "center",
    pointerX: null,
    pointerY: null,
    canvasQuality: "final",
    canvasPosition: "",
    canvasLeft: "",
    canvasTop: "",
    canvasTransform: "",
    canvasBuffer: "1600x2400",
    canvasRegion: "full",
    slotRenderState: "rendered",
    ...overrides,
  };
}

describe("pdfZoomTelemetry", () => {
  beforeEach(() => {
    clearPdfZoomLog();
    setPdfZoomTelemetryEnabled(false);
  });

  afterEach(() => {
    setPdfZoomTelemetryEnabled(false);
    vi.restoreAllMocks();
  });

  it("records nothing while disabled", () => {
    recordPdfZoomSample(sample());
    const parsed = JSON.parse(dumpPdfZoomLog()) as { samples: unknown[] };
    expect(parsed.samples).toHaveLength(0);
    expect(isPdfZoomTelemetryEnabled()).toBe(false);
  });

  it("records samples and notes while enabled", () => {
    setPdfZoomTelemetryEnabled(true);
    recordPdfZoomSample(sample({ type: "zoom", trigger: "wheel" }));
    recordPdfZoomSample(sample({ type: "scroll", trigger: "" }));
    addPdfZoomNote("zoom in");

    const parsed = JSON.parse(dumpPdfZoomLog()) as {
      notes: { text: string }[];
      samples: PdfZoomSample[];
    };
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.samples[0]).toMatchObject({ seq: 0, type: "zoom", trigger: "wheel" });
    expect(parsed.samples[1]).toMatchObject({ seq: 1, type: "scroll" });
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]!.text).toBe("zoom in");
  });

  it("exposes the runtime API on the global", () => {
    const api = (globalThis as unknown as { tuxbooksPdfZoomLog: { enable: () => void } })
      .tuxbooksPdfZoomLog;
    expect(api).toBeDefined();
    api.enable();
    expect(isPdfZoomTelemetryEnabled()).toBe(true);
    recordPdfZoomSample(sample());
    expect(dumpPdfZoomLog()).toContain('"seq": 0');
  });
});
