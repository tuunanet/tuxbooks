import { describe, expect, it } from "vitest";

import { excerptAround } from "@/lib/epub/searchExcerpt";

describe("excerptAround", () => {
  it("keeps the spaces that separate the match from its neighbours", () => {
    const text = "plan and execute tasks within agent architecture matters.";
    const match = "agent architecture";
    const excerpt = excerptAround(text, text.indexOf(match), match.length);

    expect(excerpt.pre.endsWith(" ")).toBe(true);
    expect(excerpt.post.startsWith(" ")).toBe(true);
    expect(`${excerpt.pre}${excerpt.match}${excerpt.post}`).toContain(
      "within agent architecture matters",
    );
  });

  it("collapses runs of whitespace but trims only the outer edges", () => {
    const text = "  alpha\n\tbeta gamma  ";
    const excerpt = excerptAround(text, text.indexOf("beta"), 4);

    expect(excerpt.pre).toBe("alpha ");
    expect(excerpt.match).toBe("beta");
    expect(excerpt.post).toBe(" gamma");
  });

  it("clips context at the text edges", () => {
    const excerpt = excerptAround("abracadabra", 0, 4);

    expect(excerpt.pre).toBe("");
    expect(excerpt.match).toBe("abra");
    expect(excerpt.post).toBe("cadabra");
  });
});
