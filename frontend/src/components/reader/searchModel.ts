/**
 * Format-agnostic in-book search state shared by the reader shell and the
 * navigation drawer. A match carries exactly one locator: EPUB matches
 * point at a CFI the engine can jump to, PDF matches at a 1-based page.
 */
export interface ReaderSearchExcerpt {
  pre: string;
  match: string;
  post: string;
}

export interface ReaderSearchMatch {
  /** EPUB locator the engine navigates to; null for PDF matches. */
  cfi: string | null;
  /** 1-based PDF page; null for EPUB matches. */
  page: number | null;
  excerpt: ReaderSearchExcerpt;
}

/** Matches grouped under one heading (chapter label / page). */
export interface ReaderSearchGroup {
  label: string;
  matches: ReaderSearchMatch[];
}

export interface ReaderSearchState {
  /** The book the search belongs to; stale books' results never render. */
  bookId: number;
  query: string;
  status: "running" | "done";
  groups: ReaderSearchGroup[];
  totalMatches: number;
}

export const emptySearchState = (bookId: number, query: string): ReaderSearchState => ({
  bookId,
  query,
  status: "running",
  groups: [],
  totalMatches: 0,
});

/** Streams one group into the state, ignoring anything from another book. */
export function appendSearchGroup(
  state: ReaderSearchState,
  bookId: number,
  group: ReaderSearchGroup,
): ReaderSearchState {
  if (state.bookId !== bookId) return state;
  return {
    ...state,
    groups: [...state.groups, group],
    totalMatches: state.totalMatches + group.matches.length,
  };
}

/** Marks the state done, again ignoring anything from another book. */
export function finishSearchGroup(state: ReaderSearchState, bookId: number): ReaderSearchState {
  if (state.bookId !== bookId) return state;
  return { ...state, status: "done" };
}

/**
 * What each reader (EPUB/PDF) registers with the shell so the navigation
 * drawer can drive in-book search without knowing the document format.
 */
export interface ReaderSearchController {
  run(query: string): void;
  cancel(): void;
}
