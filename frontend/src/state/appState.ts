import { createContext, useContext, type Dispatch } from "react";

/** The three major application states. Everything else is subordinate. */
export type AppView = "library" | "detail" | "reader";

export type SmartSectionId =
  "all-books" | "epubs" | "pdfs" | "recently-added" | "recently-read" | "in-progress" | "finished";

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
  selectedBookId: number | null;
  /**
   * Search text for the library header. Scoped to the active section and
   * cleared whenever the section changes, so it lives beside `section`
   * instead of in view-local state.
   */
  libraryQuery: string;
}

export type AppAction =
  | { type: "select-section"; section: LibrarySection }
  | { type: "select-book"; bookId: number | null }
  | { type: "open-book-detail"; bookId: number }
  | { type: "open-reader"; bookId: number }
  | { type: "return-to-library" }
  | { type: "set-library-query"; query: string };

export const initialAppState: AppState = {
  view: "library",
  section: { kind: "smart", id: "all-books" },
  selectedBookId: null,
  libraryQuery: "",
};

export function appStateReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "select-section":
      // Choosing a sidebar section always returns to the library view and
      // starts with an unfiltered list.
      return { ...state, view: "library", section: action.section, libraryQuery: "" };
    case "select-book":
      return { ...state, selectedBookId: action.bookId };
    case "open-book-detail":
      return { ...state, view: "detail", selectedBookId: action.bookId };
    case "open-reader":
      return { ...state, view: "reader", selectedBookId: action.bookId };
    case "return-to-library":
      return { ...state, view: "library" };
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
