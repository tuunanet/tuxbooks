import { describe, expect, test } from "vitest";

import { resolvePdfEngine } from "@/lib/pdf/pdfEngineFlag";

/**
 * The engine feature flag (ADR 0002). MuPDF must stay the default until the
 * flip ticket, so any unset or unrecognized input resolves to MuPDF.
 */
describe("PDF engine feature flag", () => {
  test("defaults to MuPDF when neither input is set", () => {
    expect(resolvePdfEngine(null, undefined)).toBe("mupdf");
    expect(resolvePdfEngine(undefined, "")).toBe("mupdf");
  });

  test("the build-time env selects PDFium", () => {
    expect(resolvePdfEngine(null, "pdfium")).toBe("pdfium");
  });

  test("runtime storage overrides the build default in both directions", () => {
    expect(resolvePdfEngine("pdfium", "mupdf")).toBe("pdfium");
    expect(resolvePdfEngine("mupdf", "pdfium")).toBe("mupdf");
  });

  test("unknown values fall back to MuPDF", () => {
    expect(resolvePdfEngine("poppler", "garbage")).toBe("mupdf");
  });
});
