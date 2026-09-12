import { createContext, useContext } from "react";
import { EPUB_DEFAULT_FONT_SIZE_PERCENT } from "@/lib/epub/appearance";

/** Visual theme of the reader surface. */
export type ReaderTheme = "light" | "paper" | "dark";

/** Paginated shows one placeholder page at a time; scrolling shows all. */
export type ReaderLayout = "paginated" | "scrolling";

/** Font family override for reflowable content; null keeps publisher styles. */
export type ReaderFontFamily = "serif" | "sans";

/**
 * Reader appearance preferences. UI-only state (no Rust mirror yet) —
 * consumed by the rendering engines (EPUB reflow styles, PDF zoom).
 */ export interface ReaderPreferences {
  /**
   * EPUB font size as a percentage of the publication's default reading size
   * (100% = native; scale in `EPUB_FONT_SIZE_SCALE_PERCENT`). Publication-
   * relative per the Readium reading-system model — never a px value — and
   * separate from the PDF reader's zoom.
   */
  epubFontSize: number;
  lineHeight: number;
  fontFamily: ReaderFontFamily | null;
  theme: ReaderTheme;
  layout: ReaderLayout;
}

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  epubFontSize: EPUB_DEFAULT_FONT_SIZE_PERCENT,
  lineHeight: 1.6,
  fontFamily: null,
  theme: "light",
  layout: "paginated",
};

export interface ReaderState {
  preferences: ReaderPreferences;
  /** Reading position as a percentage, 0–100. */
  position: number;
  setPosition: (percentage: number) => void;
  setPreferences: (patch: Partial<ReaderPreferences>) => void;
}

export const ReaderContext = createContext<ReaderState | null>(null);

export function useReader(): ReaderState {
  const reader = useContext(ReaderContext);
  if (!reader) {
    throw new Error("useReader must be used within ReaderProvider");
  }
  return reader;
}
