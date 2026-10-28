import { describe, expect, it } from "vite-plus/test";
import {
  FORMATS,
  FORMAT_FILTER_OPTIONS,
  formatFilterLabel,
  formatNames,
  toggleFormatFilter,
} from "@/lib/formats";

describe("format registry", () => {
  it("maps each format to its render engine", () => {
    expect(FORMATS.epub).toEqual({ label: "EPUB", engine: "readium" });
    expect(FORMATS.pdf).toEqual({ label: "PDF", engine: "pdfium" });
  });

  it("lists filter options in display order", () => {
    expect(FORMAT_FILTER_OPTIONS.map((option) => option.id)).toEqual(["epub", "pdf"]);
  });
});

describe("formatFilterLabel", () => {
  it("reads All formats when nothing is ticked", () => {
    expect(formatFilterLabel([])).toBe("All formats");
  });

  it("names a single format", () => {
    expect(formatFilterLabel(["pdf"])).toBe("PDF");
  });

  it("counts more than one", () => {
    expect(formatFilterLabel(["epub", "pdf"])).toBe("2 formats");
  });
});

describe("formatNames", () => {
  it("joins names for the empty state", () => {
    expect(formatNames(["epub", "pdf"])).toBe("EPUB or PDF");
  });
});

describe("toggleFormatFilter", () => {
  it("adds a format in registry order", () => {
    expect(toggleFormatFilter(["pdf"], "epub", true)).toEqual(["epub", "pdf"]);
  });

  it("removes a format", () => {
    expect(toggleFormatFilter(["epub", "pdf"], "epub", false)).toEqual(["pdf"]);
  });

  it("never duplicates an already-ticked format", () => {
    expect(toggleFormatFilter(["epub"], "epub", true)).toEqual(["epub"]);
  });
});
