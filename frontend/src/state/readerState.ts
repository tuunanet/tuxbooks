import { createContext, useContext } from "react";
import {
  EPUB_DEFAULT_COLUMN_COUNT,
  EPUB_DEFAULT_FONT_SIZE_PERCENT,
  EPUB_DEFAULT_LINE_HEIGHT,
  type EpubFontFamily,
} from "@/lib/epub/appearance";

/** Visual theme of the reader surface. */
export type ReaderTheme = "light" | "paper" | "dark";

/** Paginated shows one placeholder page at a time; scrolling shows all. */
export type ReaderLayout = "paginated" | "scrolling";

/** Font family override for reflowable content; null keeps publisher styles. */
export type ReaderFontFamily = EpubFontFamily;

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
  /**
   * EPUB line height on the reading-system scale (`EPUB_LINE_HEIGHT_SCALE`);
   * 0 = publication default (no override).
   */
  lineHeight: number;
  fontFamily: ReaderFontFamily | null;
  /**
   * EPUB column-count target for paginated reflow (1–4, issue #44): an
   * explicit maximum the engine paginates to, never an auto-fit. Ignored by
   * scrolling (stored value kept) and never applied to fixed-layout EPUBs.
   */
  columnCount: number;
  theme: ReaderTheme;
  layout: ReaderLayout;
}

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  epubFontSize: EPUB_DEFAULT_FONT_SIZE_PERCENT,
  lineHeight: EPUB_DEFAULT_LINE_HEIGHT,
  fontFamily: null,
  columnCount: EPUB_DEFAULT_COLUMN_COUNT,
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
