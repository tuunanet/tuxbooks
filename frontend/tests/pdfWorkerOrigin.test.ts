import { describe, expect, it } from "vitest";

import { isTrustedWorkerOrigin } from "@/lib/pdf/pdfWorkerOrigin";

describe("isTrustedWorkerOrigin", () => {
  it("accepts the empty origin Chromium reports for the app:// scheme", () => {
    // Regression: an exact comparison against "app://bundle" dropped every
    // prewarm/open message and the reader hung on open.
    expect(isTrustedWorkerOrigin("", "app://bundle")).toBe(true);
  });

  it("accepts the matching origin (Vite dev)", () => {
    expect(isTrustedWorkerOrigin("http://localhost:1420", "http://localhost:1420")).toBe(true);
  });

  it("rejects a foreign non-empty origin", () => {
    expect(isTrustedWorkerOrigin("https://evil.example", "app://bundle")).toBe(false);
  });
});
