import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  addPdfZoomNote,
  clearPdfZoomLog,
  dumpPdfZoomLog,
  isPdfZoomTelemetryEnabled,
  recordPdfScrollWrite,
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
    expect(parsed.samples[0]).toMatchObject({ type: "zoom", trigger: "wheel" });
    expect(parsed.samples[1]).toMatchObject({ type: "scroll" });
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]!.text).toBe("zoom in");
  });

  it("records app-driven scroll writes only while enabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordPdfScrollWrite("setScrollTop", 100, 900);
    expect(JSON.parse(dumpPdfZoomLog()).writes ?? []).toHaveLength(0);

    setPdfZoomTelemetryEnabled(true);
    recordPdfScrollWrite("setScrollTop", 100, 900);
    recordPdfScrollWrite("setScrollLeft", 0, 20);
    const parsed = JSON.parse(dumpPdfZoomLog()) as {
      writes: { helper: string; from: number; to: number }[];
    };
    expect(parsed.writes).toHaveLength(2);
    expect(parsed.writes[0]).toMatchObject({ helper: "setScrollTop", from: 100, to: 900 });
    expect(parsed.writes[1]).toMatchObject({ helper: "setScrollLeft", from: 0, to: 20 });
    // One live line per write: the terminal names an app re-anchor without
    // a download.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("scroll write setScrollTop: 100 -> 900");
  });

  it("prints a live line when the geometry moves between frames", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPdfZoomTelemetryEnabled(true);
    recordPdfZoomSample(sample({ type: "scroll", scrollHeight: 1200 }));
    recordPdfZoomSample(sample({ type: "scroll", scrollHeight: 1300, scale: 1.5 }));
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("[pdf-thumb]");
    expect(line).toContain("scrollHeight 1200->1300 (+100)");
    expect(line).toContain("scale 2.0000->1.5000");
    // An unchanged frame is silent.
    warn.mockClear();
    recordPdfZoomSample(sample({ type: "scroll", scrollHeight: 1300, scale: 1.5 }));
    expect(warn).not.toHaveBeenCalled();
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
