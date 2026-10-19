/**
 * Highlight color palette: five persisted slots resolved to translucent
 * marker washes, tuned per reader-theme family. Annotations persist the slot
 * key (`annotations.color`), so palette or override changes re-skin existing
 * highlights without migration.
 *
 * Washes are plain rgba on purpose: the EPUB engine draws highlight
 * decorations with `enforceContrast: false` so the tint reaches the page as
 * authored, and the PDF overlay composites it directly (multiply on light
 * pages, normal on dark). Per-slot alpha balances the inks — lighter hues
 * carry more alpha — so the five slots read as one marker set on every theme.
 */

import {
  epubSurfaceTheme,
  epubThemeColorScheme,
  isEpubHexColor,
  type ReaderTheme,
} from "@/lib/epub/appearance";

/** Persisted highlight slots. Never rename: annotation rows store these. */
export const HIGHLIGHT_COLOR_KEYS = ["yellow", "green", "blue", "red", "purple"] as const;

export type HighlightColor = (typeof HIGHLIGHT_COLOR_KEYS)[number];

/** New highlights default to yellow, the classic marker. */
export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = "yellow";

export function isHighlightColor(value: string | null | undefined): value is HighlightColor {
  return (
    value !== null &&
    value !== undefined &&
    (HIGHLIGHT_COLOR_KEYS as readonly string[]).includes(value)
  );
}

export type HighlightThemeFamily = "light" | "dark";

/** Which side of the theme split a reader theme renders as. */
export function readerThemeFamily(theme: ReaderTheme): HighlightThemeFamily {
  return epubThemeColorScheme(epubSurfaceTheme(theme));
}

/** One ink: the hue plus the wash alpha for its family. */
export interface HighlightInk {
  hex: string;
  alpha: number;
}

const DEFAULT_INKS: Record<HighlightThemeFamily, Record<HighlightColor, HighlightInk>> = {
  light: {
    yellow: { hex: "#ffbd1a", alpha: 0.42 },
    green: { hex: "#34bd7d", alpha: 0.34 },
    blue: { hex: "#3a94f8", alpha: 0.28 },
    red: { hex: "#ff635c", alpha: 0.3 },
    purple: { hex: "#a06cfa", alpha: 0.28 },
  },
  dark: {
    yellow: { hex: "#ffc107", alpha: 0.32 },
    green: { hex: "#4ade80", alpha: 0.26 },
    blue: { hex: "#60a5fa", alpha: 0.3 },
    red: { hex: "#fb7185", alpha: 0.3 },
    purple: { hex: "#c084fc", alpha: 0.32 },
  },
};

/** Default hue of a slot on a family — the Settings picker's resting value. */
export function defaultHighlightHex(color: HighlightColor, family: HighlightThemeFamily): string {
  return DEFAULT_INKS[family][color].hex;
}

/** Per-family slot overrides: a hex hue, or absent for the default ink. */
export type HighlightOverrideSet = Partial<Record<HighlightColor, string>>;

export interface HighlightOverrides {
  light: HighlightOverrideSet;
  dark: HighlightOverrideSet;
}

export const EMPTY_HIGHLIGHT_OVERRIDES: HighlightOverrides = { light: {}, dark: {} };

/** Validate raw stored overrides; anything that is not a slot hex is dropped. */
export function sanitizeHighlightOverrides(raw: unknown): HighlightOverrides {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (value: unknown): HighlightOverrideSet => {
    if (value === null || typeof value !== "object") return {};
    const entries = value as Record<string, unknown>;
    const out: HighlightOverrideSet = {};
    for (const color of HIGHLIGHT_COLOR_KEYS) {
      const hex = entries[color];
      if (typeof hex === "string" && isEpubHexColor(hex)) out[color] = hex.toLowerCase();
    }
    return out;
  };
  return { light: pick(source.light), dark: pick(source.dark) };
}

function hexToRgbTriplet(hex: string): string {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? digits.replaceAll(/./g, "$&$&") : digits;
  const int = Number.parseInt(full, 16);
  return `${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}`;
}

/**
 * Resolve a highlight slot to its ink. Surfaces that composite several
 * shapes as one wash (the PDF overlay's per-line rects) paint solid `hex`
 * inside a group and apply `alpha` once, so overlapping shapes cannot
 * darken; single washes (the EPUB tint, chrome swatches) compose rgba.
 * Unknown slots fall back to the yellow default.
 */
export function highlightInk(
  color: string | null | undefined,
  family: HighlightThemeFamily,
  overrides: HighlightOverrides,
): HighlightInk {
  const key = isHighlightColor(color) ? color : DEFAULT_HIGHLIGHT_COLOR;
  const ink = DEFAULT_INKS[family][key];
  return { hex: overrides[family][key] ?? ink.hex, alpha: ink.alpha };
}

/**
 * CSS color of a highlight slot on a theme family: the override hue or the
 * default ink, as the family's translucent wash. Unknown slots fall back to
 * the yellow default.
 */
export function highlightCss(
  color: string | null | undefined,
  family: HighlightThemeFamily,
  overrides: HighlightOverrides,
): string {
  const { hex, alpha } = highlightInk(color, family, overrides);
  return `rgba(${hexToRgbTriplet(hex)}, ${alpha})`;
}
