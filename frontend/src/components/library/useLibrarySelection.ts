import { useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { useAppDispatch } from "@/state/appState";

/**
 * Selection gestures for the library: plain, Ctrl/Cmd, Shift ranges, right
 * click, and the empty-space reset. Kept here so the view only wires them to
 * the card and the scroll container.
 */
export function useLibrarySelection(selectedIds: number[], visibleIds: number[]) {
  const dispatch = useAppDispatch();
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const clearSelection = useCallback(
    () => dispatch({ type: "clear-library-selection" }),
    [dispatch],
  );

  // The card hands over the event, so this is the one place that reads the
  // modifier keys and tells a right click from a plain one.
  const selectBook = useCallback(
    (bookId: number, event: ReactMouseEvent<HTMLElement>) => {
      if (event.type === "contextmenu") {
        // Right click opens the menu for the selection as it stands; only
        // an unselected book takes the selection over, and the anchor stays
        // where the last plain or Ctrl click left it.
        if (!selectedSet.has(bookId)) dispatch({ type: "library-context-select", bookId });
        return;
      }
      if (event.shiftKey) {
        dispatch({ type: "library-range-select", bookId, visibleIds });
      } else if (event.ctrlKey || event.metaKey) {
        dispatch({ type: "library-toggle-select", bookId });
      } else {
        dispatch({ type: "library-select", bookId });
      }
    },
    [dispatch, selectedSet, visibleIds],
  );

  // A plain click or a right click on empty space starts over, in the grid
  // as in the empty states below it. Cards, controls, and the missing-file
  // action buttons own their own clicks, and a modifier click on empty
  // space belongs to no book.
  const clearOnBackground = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Menus and dialogs render into a portal outside this section's DOM
      // even though React bubbles their events through it: a click there is
      // never a click on empty space.
      if (!event.currentTarget.contains(target)) return;
      if (target.closest("[data-book-card], button, input")) return;
      const modified = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
      if (modified && event.type !== "contextmenu") return;
      clearSelection();
    },
    [clearSelection],
  );

  return { selectedSet, clearSelection, selectBook, clearOnBackground };
}
