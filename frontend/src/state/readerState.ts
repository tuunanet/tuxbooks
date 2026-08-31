import { createContext, useContext } from "react";

/** Visual theme of the reader surface. */
export type ReaderTheme = "light" | "paper" | "dark";

/** Paginated shows one placeholder page at a time; scrolling shows all. */
export type ReaderLayout = "paginated" | "scrolling";

/**
 * Reader appearance preferences. UI-only state (no Rust mirror yet) — the
 * real rendering engines will consume these once they exist.
 */
export interface ReaderPreferences {
  fontSize: number;
  lineHeight: number;
  theme: ReaderTheme;
  layout: ReaderLayout;
}

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  fontSize: 17,
  lineHeight: 1.6,
  theme: "light",
  layout: "paginated",
};

/**
 * A bookmark placed at a reading position. Session-only by design: there is
 * no backend persistence for bookmarks yet, and the UI says so honestly.
 */
export interface ReaderBookmark {
  id: string;
  percentage: number;
  label: string;
}

export interface ReaderState {
  preferences: ReaderPreferences;
  /** Reading position as a percentage, 0–100. */
  position: number;
  bookmarks: ReaderBookmark[];
  setPosition: (percentage: number) => void;
  setPreferences: (patch: Partial<ReaderPreferences>) => void;
  /** Places or removes a bookmark at the current position. */
  toggleBookmark: () => void;
}

export const ReaderContext = createContext<ReaderState | null>(null);

export function useReader(): ReaderState {
  const reader = useContext(ReaderContext);
  if (!reader) {
    throw new Error("useReader must be used within ReaderProvider");
  }
  return reader;
}
