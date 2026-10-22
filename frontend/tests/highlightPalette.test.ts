import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_HIGHLIGHT_COLOR,
  EMPTY_HIGHLIGHT_OVERRIDES,
  HIGHLIGHT_COLOR_KEYS,
  defaultHighlightHex,
  highlightCss,
  isHighlightColor,
  readerThemeFamily,
  sanitizeHighlightOverrides,
} from "@/lib/highlightPalette";

describe("highlightPalette", () => {
  it("keeps the five persisted slots", () => {
    expect([...HIGHLIGHT_COLOR_KEYS]).toEqual(["yellow", "green", "blue", "red", "purple"]);
    expect(DEFAULT_HIGHLIGHT_COLOR).toBe("yellow");
  });

  it("maps every reader theme onto its family", () => {
    expect(readerThemeFamily("default")).toBe("light");
    expect(readerThemeFamily("light")).toBe("light");
    expect(readerThemeFamily("paper")).toBe("light");
    expect(readerThemeFamily("mint-contrast")).toBe("light");
    expect(readerThemeFamily("dark")).toBe("dark");
    expect(readerThemeFamily("contrast")).toBe("dark");
    expect(readerThemeFamily("blue-contrast")).toBe("dark");
    expect(readerThemeFamily("invert")).toBe("dark");
  });

  it("resolves the balanced default washes", () => {
    expect(highlightCss("yellow", "light", EMPTY_HIGHLIGHT_OVERRIDES)).toBe(
      "rgba(255, 189, 26, 0.42)",
    );
    expect(highlightCss("green", "light", EMPTY_HIGHLIGHT_OVERRIDES)).toBe(
      "rgba(52, 189, 125, 0.34)",
    );
    expect(highlightCss("blue", "light", EMPTY_HIGHLIGHT_OVERRIDES)).toBe(
      "rgba(58, 148, 248, 0.28)",
    );
    expect(highlightCss("red", "dark", EMPTY_HIGHLIGHT_OVERRIDES)).toBe("rgba(251, 113, 133, 0.3)");
    expect(highlightCss("purple", "dark", EMPTY_HIGHLIGHT_OVERRIDES)).toBe(
      "rgba(192, 132, 252, 0.32)",
    );
  });

  it("resolves unknown slots to the yellow default", () => {
    expect(highlightCss(null, "light", EMPTY_HIGHLIGHT_OVERRIDES)).toBe(
      highlightCss("yellow", "light", EMPTY_HIGHLIGHT_OVERRIDES),
    );
    expect(highlightCss("chartreuse", "dark", EMPTY_HIGHLIGHT_OVERRIDES)).toBe(
      highlightCss("yellow", "dark", EMPTY_HIGHLIGHT_OVERRIDES),
    );
  });

  it("applies an override hue with the slot's family wash", () => {
    const overrides = sanitizeHighlightOverrides({ light: { yellow: "#1E90FF" }, dark: {} });
    expect(overrides).toEqual({ light: { yellow: "#1e90ff" }, dark: {} });
    expect(highlightCss("yellow", "light", overrides)).toBe("rgba(30, 144, 255, 0.42)");
    expect(defaultHighlightHex("yellow", "light")).toBe("#ffbd1a");
  });

  it("validates slot membership", () => {
    expect(isHighlightColor("red")).toBe(true);
    expect(isHighlightColor("orange")).toBe(false);
    expect(isHighlightColor(null)).toBe(false);
  });

  it("drops invalid overrides and keeps valid ones", () => {
    const overrides = sanitizeHighlightOverrides({
      light: { yellow: "rgb(1,2,3)", green: "#AABBCC", blue: 42, red: null, purple: "#12ghij" },
      dark: "nope",
    });
    expect(overrides).toEqual({ light: { green: "#aabbcc" }, dark: {} });
  });
});
