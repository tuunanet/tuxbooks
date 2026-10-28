import { useCallback, useState, type RefObject } from "react";
import { useShortcut } from "@/lib/shortcuts";
import { READER_SEARCH_SHORTCUTS } from "@/lib/readerShortcuts";
import { jumpToSearchMatch, type ReaderAdapter, type ReaderJump } from "../readerModel";
import {
  appendSearchGroup,
  emptySearchState,
  finishSearchGroup,
  type ReaderSearchGroup,
  type ReaderSearchMatch,
  type ReaderSearchState,
} from "../searchModel";

interface UseReaderSearchInput {
  bookId: number;
  adapterRef: RefObject<ReaderAdapter | null>;
  jump: (target: ReaderJump) => void;
}

/**
 * In-book search: the shell owns the state (one book open at a time), the
 * open reader's adapter streams matches in through the shared model helpers,
 * which ignore anything not belonging to the book being searched.
 */
export function useReaderSearch({ bookId, adapterRef, jump }: UseReaderSearchInput) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchState, setSearchState] = useState<ReaderSearchState | null>(null);
  // A search overlay never outlives its book: the next book starts with the
  // overlay closed and its own (empty) query.
  const [searchBookId, setSearchBookId] = useState(bookId);
  if (searchBookId !== bookId) {
    setSearchBookId(bookId);
    setSearchOpen(false);
  }

  // Ctrl/Cmd+F toggles the overlay, so a second press closes it without
  // reaching for the mouse.
  const toggleSearch = useCallback(() => setSearchOpen((open) => !open), []);
  useShortcut(READER_SEARCH_SHORTCUTS.primary, toggleSearch);

  const runSearch = useCallback(
    (query: string) => {
      if (query === "") {
        adapterRef.current?.search.cancel();
        setSearchState(null);
        return;
      }
      setSearchState(emptySearchState(bookId, query));
      adapterRef.current?.search.run(query);
    },
    [adapterRef, bookId],
  );
  const appendSearchGroupFrom = useCallback((id: number, group: ReaderSearchGroup) => {
    setSearchState((prev) => (prev ? appendSearchGroup(prev, id, group) : prev));
  }, []);
  const finishSearchFrom = useCallback((id: number, truncated: boolean) => {
    setSearchState((prev) => (prev ? finishSearchGroup(prev, id, truncated) : prev));
  }, []);
  const pickSearchMatch = useCallback(
    (match: ReaderSearchMatch) => {
      const target = jumpToSearchMatch(match);
      if (target) jump(target);
    },
    [jump],
  );

  return {
    searchOpen,
    setSearchOpen,
    toggleSearch,
    activeSearch: searchState !== null && searchState.bookId === bookId ? searchState : null,
    runSearch,
    appendSearchGroupFrom,
    finishSearchFrom,
    pickSearchMatch,
  };
}
