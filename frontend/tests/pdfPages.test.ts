import { describe, expect, it } from "vitest";
import { pageToPosition, parsePageNumber, positionToPage } from "@/components/reader/pdf/pdfPages";

describe("parsePageNumber", () => {
  it("reads a valid page number, ignoring surrounding whitespace", () => {
    expect(parsePageNumber("3", 10)).toBe(3);
    expect(parsePageNumber(" 7 ", 10)).toBe(7);
    expect(parsePageNumber("10", 10)).toBe(10);
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parsePageNumber("", 10)).toBeNull();
    expect(parsePageNumber("   ", 10)).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parsePageNumber("abc", 10)).toBeNull();
    expect(parsePageNumber("12px", 10)).toBeNull();
  });

  it("truncates a decimal to a whole page", () => {
    expect(parsePageNumber("2.9", 10)).toBe(2);
    expect(parsePageNumber("2.1", 10)).toBe(2);
  });

  it("clamps values below one to page one", () => {
    expect(parsePageNumber("0", 10)).toBe(1);
    expect(parsePageNumber("-4", 10)).toBe(1);
  });

  it("clamps values above the page count to the last page", () => {
    expect(parsePageNumber("11", 10)).toBe(10);
    expect(parsePageNumber("9999", 10)).toBe(10);
  });

  it("rejects non-finite input", () => {
    expect(parsePageNumber("Infinity", 10)).toBeNull();
    expect(parsePageNumber("-Infinity", 10)).toBeNull();
    expect(parsePageNumber("NaN", 10)).toBeNull();
  });

  it("rejects every input for an empty document", () => {
    expect(parsePageNumber("3", 0)).toBeNull();
    expect(parsePageNumber("3", -1)).toBeNull();
  });
});

describe("positionToPage and pageToPosition", () => {
  it("round-trips a page through the reading position", () => {
    expect(positionToPage(0, 3)).toBe(1);
    expect(positionToPage(100, 3)).toBe(3);
    expect(pageToPosition(1, 3)).toBe(0);
    expect(pageToPosition(3, 3)).toBe(100);
  });
});
