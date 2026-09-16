import { describe, expect, it } from "vitest";

import { MAX_EXTERNAL_URL_LENGTH, parseExternalHttpUrl } from "../../../electron/shared/linkPolicy";

describe("parseExternalHttpUrl (X-5: only validated http(s) URLs reach shell.openExternal)", () => {
  it("accepts a plain https URL and returns the re-serialized href", () => {
    expect(parseExternalHttpUrl("https://example.com/path")).toBe("https://example.com/path");
  });

  it("accepts http and normalizes the empty path", () => {
    expect(parseExternalHttpUrl("http://example.com")).toBe("http://example.com/");
  });

  it("lowercases scheme and host but preserves path case", () => {
    expect(parseExternalHttpUrl("HTTPS://EXAMPLE.COM/Path?q=1")).toBe(
      "https://example.com/Path?q=1",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(parseExternalHttpUrl("  https://example.com/page  ")).toBe("https://example.com/page");
  });

  it("percent-encodes inner spaces instead of passing them raw", () => {
    expect(parseExternalHttpUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
  });

  it("rejects script schemes", () => {
    expect(parseExternalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(parseExternalHttpUrl("vbscript:msgbox(1)")).toBeNull();
    expect(parseExternalHttpUrl("JAVASCRIPT:alert(1)")).toBeNull();
  });

  it("rejects data, file, custom, and internal schemes", () => {
    expect(parseExternalHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(parseExternalHttpUrl("file:///etc/passwd")).toBeNull();
    expect(parseExternalHttpUrl("chrome://settings")).toBeNull();
    expect(parseExternalHttpUrl("tuxbooks://book/1")).toBeNull();
    expect(parseExternalHttpUrl("app://bundle/index.html")).toBeNull();
  });

  it("rejects protocol-relative and relative references", () => {
    expect(parseExternalHttpUrl("//evil.example/x")).toBeNull();
    expect(parseExternalHttpUrl("/relative/path")).toBeNull();
    expect(parseExternalHttpUrl("example.com/page")).toBeNull();
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parseExternalHttpUrl("")).toBeNull();
    expect(parseExternalHttpUrl("   ")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(parseExternalHttpUrl(null)).toBeNull();
    expect(parseExternalHttpUrl(undefined)).toBeNull();
    expect(parseExternalHttpUrl(42)).toBeNull();
    expect(parseExternalHttpUrl({ href: "https://example.com" })).toBeNull();
  });

  it("rejects host-less URLs", () => {
    expect(parseExternalHttpUrl("https://")).toBeNull();
  });

  it("collapses extra slashes to a single-label host (WHATWG parsing)", () => {
    expect(parseExternalHttpUrl("https:///path")).toBe("https://path/");
  });

  it("rejects embedded credentials", () => {
    expect(parseExternalHttpUrl("https://user:pass@example.com/")).toBeNull();
    expect(parseExternalHttpUrl("https://user@example.com/")).toBeNull();
  });

  it("rejects control characters anywhere in the input", () => {
    expect(parseExternalHttpUrl("https://example.co\0m/x")).toBeNull();
    expect(parseExternalHttpUrl("https://evil.example\n.evil/")).toBeNull();
    expect(parseExternalHttpUrl("https://example.com/\r\tx")).toBeNull();
  });

  it("rejects URLs over the length cap", () => {
    const long = `https://example.com/${"a".repeat(MAX_EXTERNAL_URL_LENGTH)}`;
    expect(parseExternalHttpUrl(long)).toBeNull();
  });
});
