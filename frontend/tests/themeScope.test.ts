import { describe, expect, it } from "vite-plus/test";
import { EPUB_THEME_COLORS, readerThemeVariables, type EpubThemeName } from "@/lib/epub/appearance";
import { readerThemeScope, readerThemeStyle, themeScopeStyle } from "@/lib/themeScope";

/**
 * Tokens every reader surface consumes. A new preset must produce all of
 * them from its background/text pair; missing one silently falls back to the
 * app theme and reintroduces the light/dark leak this list guards against.
 */
const REQUIRED_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-border",
  "--destructive-soft",
  "--destructive-soft-hover",
  "--destructive-ring",
  "--border",
  "--input",
  "--ring",
  "--control",
  "--control-hover",
  "--control-disabled",
  "--control-border",
  "--ghost-hover",
  "--tab-fg",
  "--tab-active",
  "--tab-active-border",
  "--status-info",
  "--status-info-soft",
  "--status-info-border",
  "--status-warning",
  "--status-warning-soft",
  "--status-warning-border",
  "--status-success",
  "--status-success-soft",
  "--status-success-border",
  "--status-destructive",
  "--status-destructive-soft",
  "--status-destructive-border",
  "--reader-chrome-muted",
  "--reader-chrome-border",
  "--reader-chrome-surface",
  "--reader-chrome-card",
  "--reader-progress-fill",
  "--reader-progress-track",
];

describe("theme scope", () => {
  it("keeps the neutral reader theme on the app scope", () => {
    expect(readerThemeScope("default")).toEqual({ kind: "app" });
    expect(themeScopeStyle({ kind: "app" })).toEqual({});
    expect(readerThemeStyle("default")).toEqual({});
  });

  it("normalizes the PDF-only invert preset to the dark reader scope", () => {
    expect(readerThemeScope("invert")).toEqual({ kind: "reader", theme: "invert" });
    expect(themeScopeStyle({ kind: "reader", theme: "invert" })).toMatchObject({
      colorScheme: "dark",
      "--background": "#101013",
    });
  });

  it("gives every reader preset a complete token set", () => {
    const themes = Object.keys(EPUB_THEME_COLORS) as Exclude<EpubThemeName, "default">[];
    for (const theme of themes) {
      const variables = readerThemeVariables(theme);
      expect(variables, theme).toBeDefined();
      for (const token of REQUIRED_TOKENS) {
        expect(variables, `${theme} is missing ${token}`).toHaveProperty(token);
      }
      expect(variables?.["--background"]).toBe(EPUB_THEME_COLORS[theme].background);
    }
  });
});
