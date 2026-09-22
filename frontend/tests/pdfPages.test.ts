import { describe, expect, it } from "vitest";
import { parsePageNumber } from "@/components/reader/pdf/pdfPages";

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

  it("rejects input that is not a run of digits", () => {
    expect(parsePageNumber("abc", 10)).toBeNull();
    expect(parsePageNumber("12px", 10)).toBeNull();
    expect(parsePageNumber("-4", 10)).toBeNull();
    expect(parsePageNumber("2.9", 10)).toBeNull();
    expect(parsePageNumber("1e3", 10)).toBeNull();
    expect(parsePageNumber("0x10", 10)).toBeNull();
    expect(parsePageNumber("Infinity", 10)).toBeNull();
    expect(parsePageNumber("NaN", 10)).toBeNull();
  });

  it("clamps zero below one to page one", () => {
    expect(parsePageNumber("0", 10)).toBe(1);
    expect(parsePageNumber("00", 10)).toBe(1);
  });

  it("clamps values above the page count to the last page", () => {
    expect(parsePageNumber("11", 10)).toBe(10);
    expect(parsePageNumber("9999", 10)).toBe(10);
  });

  it("rejects every input for an empty document", () => {
    expect(parsePageNumber("3", 0)).toBeNull();
    expect(parsePageNumber("3", -1)).toBeNull();
  });
});
