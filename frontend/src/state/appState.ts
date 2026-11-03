import { createContext, useContext, type Dispatch } from "react";
import type { BookFormat } from "@/types/domain";

/** The three major application states. Everything else is subordinate. */
export type AppView = "library" | "detail" | "reader";

/** Sections inside the book detail view. */
export type DetailTab = "overview" | "metadata" | "highlights" | "bookmarks";

export type SmartSectionId =
  | "all-books"
  | "recently-added"
  | "recently-read"
  | "in-progress"
  | "finished";

/** Library sort orders. Section order defers to the active place's natural order. */
export type BookSortId = "section-order" | "date-added" | "last-read" | "title" | "author";

/**
 * What the sidebar has selected. Smart sections are built-in views; a
 * collection place holds one or more selected collections, kept in sidebar
 * order so the title and union projection agree on their sequence.
 */
export type LibrarySection =
  | { kind: "smart"; id: SmartSectionId }
  | { kind: "collection"; ids: number[] }
  | { kind: "reading-history" };

/** How a sidebar collection click changes the collection place. */
export type CollectionSelectMode = "replace" | "toggle" | "range";

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
   * The collection anchor for Shift-click ranges in the sidebar, always the
   * last plain or Ctrl clicked collection row. Shift-click never moves it;
   * a smart section clears it.
   */
  collectionAnchorId: number | null;
  /**
   * Section shown inside the detail view (issue #58). Metadata is the
   * primary curation surface; Overview keeps the operational facts.
   * Optional so partial test/preview states keep working; the provider
   * defaults it to "overview".
   */
  detailTab?: DetailTab;
  /**
   * Highlight the reader should reveal once its document is ready. The
   * detail view's Highlights tab sets it when a row is clicked; the reader
   * consumes it once, so a later plain open never restores it.
   */
  readerTargetAnnotationId?: number | null;
  /**
   * Search text for the library header. Scoped to the active section and
   * cleared whenever the section changes, so it lives beside `section`
   * instead of in view-local state.
   */
  libraryQuery: string;
  /**
   * Formats the library shows; empty means no restriction. Unlike the query,
   * it survives section changes because it composes with every section and
   * collection instead of scoping one.
   */
  formatFilter: BookFormat[];
  /**
   * Library sort order. It composes with every section and collection, so it
   * survives place changes instead of being reset with the section.
   */
  sort: BookSortId;
  /**
   * Whether the Settings window is open. Settings floats above whatever is
   * underneath, so it stays reachable from the library, a book detail, and
   * the reader without changing the view.
   */
  settingsOpen: boolean;
}

export type AppAction =
  | { type: "select-section"; section: LibrarySection }
  | {
      type: "select-collection";
      collectionId: number;
      mode: CollectionSelectMode;
      /** The collection rows on screen, in sidebar order. */
      visibleIds: number[];
    }
  | { type: "library-select"; bookId: number }
  /** Right-click takeover: the selection becomes this book, the anchor stays. */
  | { type: "library-context-select"; bookId: number }
  | { type: "library-toggle-select"; bookId: number }
  /** `visibleIds` is the on-screen order, after search and sort. */
  | { type: "library-range-select"; bookId: number; visibleIds: number[] }
  | { type: "clear-library-selection" }
  | { type: "open-book-detail"; bookId: number; tab?: DetailTab }
  | { type: "open-reader"; bookId: number; annotationId?: number }
  | { type: "reader-target-consumed" }
  | { type: "return-to-library" }
  | { type: "select-detail-tab"; tab: DetailTab }
  | { type: "set-library-query"; query: string }
  | { type: "set-format-filter"; formats: BookFormat[] }
  | { type: "set-library-sort"; sort: BookSortId }
  | { type: "open-settings" }
  | { type: "close-settings" };

export const initialAppState: AppState = {
  view: "library",
  section: { kind: "smart", id: "all-books" },
  selectedBookId: null,
  selectedBookIds: [],
  selectionAnchorId: null,
  collectionAnchorId: null,
  detailTab: "overview",
  readerTargetAnnotationId: null,
  libraryQuery: "",
  formatFilter: [],
  sort: "section-order",
  settingsOpen: false,
};

type SettingsAction = Extract<AppAction, { type: "open-settings" | "close-settings" }>;
type LibrarySelectionAction = Extract<
  AppAction,
  {
    type:
      | "library-select"
      | "library-context-select"
      | "library-toggle-select"
      | "library-range-select"
      | "clear-library-selection";
  }
>;

function isSettingsAction(action: AppAction): action is SettingsAction {
  return action.type === "open-settings" || action.type === "close-settings";
}

function reduceSettings(state: AppState, action: SettingsAction): AppState {
  if (action.type === "open-settings") {
    return state.settingsOpen ? state : { ...state, settingsOpen: true };
  }
  return state.settingsOpen ? { ...state, settingsOpen: false } : state;
}

function isLibrarySelectionAction(action: AppAction): action is LibrarySelectionAction {
  return (
    action.type === "library-select" ||
    action.type === "library-context-select" ||
    action.type === "library-toggle-select" ||
    action.type === "library-range-select" ||
    action.type === "clear-library-selection"
  );
}

function reduceLibrarySelection(state: AppState, action: LibrarySelectionAction): AppState {
  switch (action.type) {
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
    case "clear-library-selection":
      if (state.selectedBookIds.length === 0 && state.selectionAnchorId === null) return state;
      return { ...state, selectedBookIds: [], selectionAnchorId: null };
  }
}

/** The place a set of selected collections forms; empty means All Books. */
function collectionPlace(ids: number[]): LibrarySection {
  return ids.length === 0 ? { kind: "smart", id: "all-books" } : { kind: "collection", ids };
}

/**
 * Entering a place returns to the library and clears the section-scoped
 * search and book selection; the format filter and sort stay because they
 * compose with every place.
 */
function enterPlace(
  state: AppState,
  section: LibrarySection,
  collectionAnchorId: number | null,
): AppState {
  return {
    ...state,
    view: "library",
    section,
    collectionAnchorId,
    libraryQuery: "",
    selectedBookIds: [],
    selectionAnchorId: null,
  };
}

/**
 * Orders a selection by the visible sidebar rows (ticket 4 will supply the
 * grouped order). Collections the caller did not list stay after the visible
 * ones, keeping their relative click order.
 */
function inSidebarOrder(ids: number[], visibleIds: number[]): number[] {
  const selected = new Set(ids);
  const ordered = visibleIds.filter((id) => selected.has(id));
  for (const id of ids) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

function reduceCollectionSelection(
  state: AppState,
  action: Extract<AppAction, { type: "select-collection" }>,
): AppState {
  const currentIds = state.section.kind === "collection" ? state.section.ids : [];
  let ids: number[] = currentIds;
  let anchorId = state.collectionAnchorId;

  switch (action.mode) {
    case "replace":
      ids = [action.collectionId];
      anchorId = action.collectionId;
      break;
    case "toggle": {
      ids = currentIds.includes(action.collectionId)
        ? currentIds.filter((id) => id !== action.collectionId)
        : [...currentIds, action.collectionId];
      // The anchor moves even when the click removes a collection, matching
      // the book-selection gestures.
      anchorId = action.collectionId;
      break;
    }
    case "range": {
      const anchorIndex = anchorId === null ? -1 : action.visibleIds.indexOf(anchorId);
      const targetIndex = action.visibleIds.indexOf(action.collectionId);
      // Without a visible anchor there is no range to take, so fall back to
      // the target alone and leave the anchor where the last click put it.
      ids =
        anchorIndex < 0 || targetIndex < 0
          ? [action.collectionId]
          : action.visibleIds.slice(
              Math.min(anchorIndex, targetIndex),
              Math.max(anchorIndex, targetIndex) + 1,
            );
      break;
    }
  }

  ids = inSidebarOrder(ids, action.visibleIds);
  if (ids.length === 0) anchorId = null;

  return enterPlace(state, collectionPlace(ids), anchorId);
}

export function appStateReducer(state: AppState, action: AppAction): AppState {
  if (isSettingsAction(action)) return reduceSettings(state, action);
  if (isLibrarySelectionAction(action)) return reduceLibrarySelection(state, action);
  if (action.type === "select-collection") return reduceCollectionSelection(state, action);

  switch (action.type) {
    case "select-section": {
      // Collections reached through direct navigation (creating one) anchor
      // their last id so a Shift+click has somewhere to start.
      const anchorId =
        action.section.kind === "collection"
          ? (action.section.ids[action.section.ids.length - 1] ?? null)
          : null;
      return enterPlace(state, action.section, anchorId);
    }
    case "open-book-detail":
      return {
        ...state,
        view: "detail",
        selectedBookId: action.bookId,
        detailTab: action.tab ?? "overview",
      };
    case "open-reader":
      return {
        ...state,
        view: "reader",
        selectedBookId: action.bookId,
        readerTargetAnnotationId: action.annotationId ?? null,
      };
    case "reader-target-consumed":
      return state.readerTargetAnnotationId == null
        ? state
        : { ...state, readerTargetAnnotationId: null };
    case "return-to-library":
      return { ...state, view: "library" };
    case "select-detail-tab":
      return state.detailTab === action.tab ? state : { ...state, detailTab: action.tab };
    case "set-library-query":
      return state.libraryQuery === action.query ? state : { ...state, libraryQuery: action.query };
    case "set-format-filter": {
      const current = state.formatFilter;
      const next = action.formats;
      const unchanged =
        current.length === next.length && current.every((format, index) => format === next[index]);
      return unchanged ? state : { ...state, formatFilter: next };
    }
    case "set-library-sort":
      return state.sort === action.sort ? state : { ...state, sort: action.sort };
  }
}

export function sameSection(a: LibrarySection, b: LibrarySection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "smart" && b.kind === "smart") return a.id === b.id;
  if (a.kind === "collection" && b.kind === "collection") {
    return a.ids.length === b.ids.length && a.ids.every((id, index) => id === b.ids[index]);
  }
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
