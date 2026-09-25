import { createContext, useContext, type Dispatch } from "react";

/** The three major application states. Everything else is subordinate. */
export type AppView = "library" | "detail" | "reader";

/** Sections inside the book detail view; only the first two ship today. */
export type DetailTab = "overview" | "metadata";

export type SmartSectionId =
  | "all-books"
  | "epubs"
  | "pdfs"
  | "recently-added"
  | "recently-read"
  | "in-progress"
  | "finished"
  | "outside-watched";

/**
 * What the sidebar has selected. Smart sections are built-in views; collection
 * sections will address user-created collections once a backend command
 * exposes them.
 */
export type LibrarySection =
  { kind: "smart"; id: SmartSectionId } | { kind: "collection"; id: number } | { kind: "settings" };

export interface AppState {
  view: AppView;
  section: LibrarySection;
  /**
   * The book the detail and reader views show. Library multi-selection is
   * `selectedBookIds`; this stays the single navigation target.
   */
  selectedBookId: number | null;
  /**
   * Books highlighted in the library grid and list. A plain click replaces
   * the set, Ctrl/Cmd+click toggles one book, Shift+click takes the range
   * from the anchor over the visible order. Ids survive search and sort, so
   * a filtered-out book stays selected.
   */
  selectedBookIds: number[];
  /**
   * The anchor for Shift-click ranges, always the last plain or Ctrl click.
   * Shift-click and right-click never move it.
   */
  selectionAnchorId: number | null;
  /**
   * Section shown inside the detail view (issue #58). Metadata is the
   * primary curation surface; Overview keeps the operational facts.
   * Optional so partial test/preview states keep working; the provider
   * defaults it to "overview".
   */
  detailTab?: DetailTab;
  /**
   * Search text for the library header. Scoped to the active section and
   * cleared whenever the section changes, so it lives beside `section`
   * instead of in view-local state.
   */
  libraryQuery: string;
}

export type AppAction =
  | { type: "select-section"; section: LibrarySection }
  | { type: "library-select"; bookId: number }
  /** Right-click takeover: the selection becomes this book, the anchor stays. */
  | { type: "library-context-select"; bookId: number }
  | { type: "library-toggle-select"; bookId: number }
  /** `visibleIds` is the on-screen order, after search and sort. */
  | { type: "library-range-select"; bookId: number; visibleIds: number[] }
  | { type: "clear-library-selection" }
  | { type: "open-book-detail"; bookId: number; tab?: DetailTab }
  | { type: "open-reader"; bookId: number }
  | { type: "return-to-library" }
  | { type: "select-detail-tab"; tab: DetailTab }
  | { type: "set-library-query"; query: string };

export const initialAppState: AppState = {
  view: "library",
  section: { kind: "smart", id: "all-books" },
  selectedBookId: null,
  selectedBookIds: [],
  selectionAnchorId: null,
  detailTab: "overview",
  libraryQuery: "",
};

export function appStateReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "select-section":
      // Choosing a sidebar section always returns to the library view and
      // starts with an unfiltered list; a selection from the old slice
      // would point at books the new one may not show.
      return {
        ...state,
        view: "library",
        section: action.section,
        libraryQuery: "",
        selectedBookIds: [],
        selectionAnchorId: null,
      };
    case "library-select":
      return { ...state, selectedBookIds: [action.bookId], selectionAnchorId: action.bookId };
    case "library-context-select":
      // A right click takes the selection over but leaves the anchor alone,
      // so the next Shift+click still measures from the last plain or Ctrl
      // click.
      return { ...state, selectedBookIds: [action.bookId] };
    case "library-toggle-select": {
      const selected = state.selectedBookIds;
      return {
        ...state,
        selectedBookIds: selected.includes(action.bookId)
          ? selected.filter((id) => id !== action.bookId)
          : [...selected, action.bookId],
        selectionAnchorId: action.bookId,
      };
    }
    case "library-range-select": {
      const anchorId = state.selectionAnchorId;
      const anchorIndex = anchorId === null ? -1 : action.visibleIds.indexOf(anchorId);
      const targetIndex = action.visibleIds.indexOf(action.bookId);
      // Without an anchor on screen (nothing clicked yet, or the filter hid
      // it) there is no range to take, so fall back to the target alone and
      // leave the anchor where the last plain or Ctrl click put it.
      if (anchorIndex < 0 || targetIndex < 0) {
        return { ...state, selectedBookIds: [action.bookId] };
      }
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      return { ...state, selectedBookIds: action.visibleIds.slice(start, end + 1) };
    }
    case "clear-library-selection": {
      if (state.selectedBookIds.length === 0 && state.selectionAnchorId === null) return state;
      return { ...state, selectedBookIds: [], selectionAnchorId: null };
    }
    case "open-book-detail":
      return {
        ...state,
        view: "detail",
        selectedBookId: action.bookId,
        detailTab: action.tab ?? "overview",
      };
    case "open-reader":
      return { ...state, view: "reader", selectedBookId: action.bookId };
    case "return-to-library":
      return { ...state, view: "library" };
    case "select-detail-tab":
      return state.detailTab === action.tab ? state : { ...state, detailTab: action.tab };
    case "set-library-query":
      return state.libraryQuery === action.query ? state : { ...state, libraryQuery: action.query };
  }
}

export function sameSection(a: LibrarySection, b: LibrarySection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "smart" && b.kind === "smart") return a.id === b.id;
  if (a.kind === "collection" && b.kind === "collection") return a.id === b.id;
  return true;
}

export const AppStateContext = createContext<AppState | null>(null);
export const AppDispatchContext = createContext<Dispatch<AppAction> | null>(null);

export function useAppState(): AppState {
  const state = useContext(AppStateContext);
  if (!state) {
    throw new Error("useAppState must be used within AppStateProvider");
  }
  return state;
}

export function useAppDispatch(): Dispatch<AppAction> {
  const dispatch = useContext(AppDispatchContext);
  if (!dispatch) {
    throw new Error("useAppDispatch must be used within AppStateProvider");
  }
  return dispatch;
}
