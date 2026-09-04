import { describe, expect, it } from "vitest";
import { assemblePageText, findPageMatches } from "@/lib/pdf/pdfSearch";

describe("assemblePageText", () => {
  it("joins items with single spaces", () => {
    expect(
      assemblePageText([
        { str: "The quick", hasEOL: false },
        { str: "brown fox", hasEOL: true },
        { str: "jumps.", hasEOL: false },
      ]),
    ).toBe("The quick brown fox jumps.");
  });

  it("does not double spaces that items already carry", () => {
    expect(
      assemblePageText([
        { str: "alpha ", hasEOL: false },
        { str: " beta", hasEOL: false },
      ]),
    ).toBe("alpha beta");
  });

  it("collapses EOL breaks into spaces so queries match across lines", () => {
    expect(
      assemblePageText([
        { str: "river-", hasEOL: true },
        { str: "bank", hasEOL: true },
      ]),
    ).toBe("river- bank");
  });

  it("returns an empty string for no items", () => {
    expect(assemblePageText([])).toBe("");
  });
});

describe("findPageMatches", () => {
  const text = "The mole had been working. A mole in the morning.";

  it("finds every case-insensitive occurrence in order", () => {
    const matches = findPageMatches(text, "MOLE");
    expect(matches).toHaveLength(2);
    expect(matches[0]?.match).toBe("mole");
    expect(matches[1]?.match).toBe("mole");
  });

  it("builds excerpts with surrounding context", () => {
    const [first] = findPageMatches(text, "mole");
    expect(first?.pre).toBe("The ");
    expect(first?.match).toBe("mole");
    expect(first?.post.startsWith(" had been")).toBe(true);
  });

  it("clips context at the text edges", () => {
    const [first] = findPageMatches("abracadabra", "abra");
    expect(first?.pre).toBe("");
    expect(first?.match).toBe("abra");
    expect(first?.post).toBe("cadabra");
  });

  it("finds matches across item boundaries via assembled text", () => {
    const assembled = assemblePageText([
      { str: "wind", hasEOL: true },
      { str: "in the willows", hasEOL: false },
    ]);
    expect(findPageMatches(assembled, "wind in")).toHaveLength(1);
  });

  it("returns nothing for an empty query", () => {
    expect(findPageMatches(text, "")).toEqual([]);
  });

  it("returns nothing when the term is absent", () => {
    expect(findPageMatches(text, "badger")).toEqual([]);
  });
});
