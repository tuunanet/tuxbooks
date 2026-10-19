import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { LoaderCircle, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  epubSurfaceTheme,
  readerPopoverVariables,
  readerScrollbarColor,
  type ReaderTheme,
} from "@/lib/epub/appearance";
import type { ReaderSearchMatch, ReaderSearchState } from "./searchModel";

/** Wait this long after the last keystroke before asking the book to search. */
const SEARCH_DEBOUNCE_MS = 200;

interface ReaderSearchOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Results for the open book; null before the first search or for another book. */
  search: ReaderSearchState | null;
  /** Starts (or clears) the in-book search for the open book. */
  onSearch: (query: string) => void;
  /** Navigates to a match and closes the overlay. */
  onPickMatch: (match: ReaderSearchMatch) => void;
  /** Active reader theme; the portaled overlay re-themes its app tokens to it. */
  theme: ReaderTheme;
}

interface FlatMatch {
  match: ReaderSearchMatch;
  /** Chapter label (EPUB) or page label (PDF) for this match. */
  label: string;
}

function flattenMatches(search: ReaderSearchState | null): FlatMatch[] {
  if (search === null) return [];
  return search.groups.flatMap((group) =>
    group.matches.map((match) => ({ match, label: group.label })),
  );
}

function resultId(index: number): string {
  return `reader-search-option-${index}`;
}

/**
 * Spotlight-style in-book search over the reader. The shell owns the search
 * state and the reader adapter; this surface only turns a query into a
 * debounced `onSearch`, flattens the streaming groups into one document-order
 * list, and jumps to the picked match.
 *
 * Opening it again restores the last query and results without re-running the
 * search. Picking a match closes the overlay and leaves the query in place.
 */
export function ReaderSearchOverlay({
  open,
  onOpenChange,
  search,
  onSearch,
  onPickMatch,
  theme,
}: ReaderSearchOverlayProps) {
  const surfaceTheme = epubSurfaceTheme(theme);
  const popoverVariables = readerPopoverVariables(surfaceTheme);
  const scrollbarColor = readerScrollbarColor(surfaceTheme);
  const style = {
    ...(popoverVariables ?? {}),
    ...(scrollbarColor === undefined ? {} : { "--reader-scrollbar-thumb": scrollbarColor }),
  } as CSSProperties;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="reader-search-overlay"
        showCloseButton={false}
        className="top-[12vh] left-1/2 flex max-h-[min(70vh,600px)] w-[min(640px,calc(100vw-2rem))] max-w-none -translate-x-1/2 translate-y-0 flex-col gap-0 overflow-hidden rounded-2xl border-0 bg-popover/90 p-0 shadow-2xl ring-1 ring-foreground/10 backdrop-blur-xl duration-150 sm:max-w-none"
        style={style}
        // The input owns the keyboard; keeping focus off the trigger makes
        // the arrow keys available to the result list from the first frame.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">Search in book</DialogTitle>
        <DialogDescription className="sr-only">
          Search the text of this book and jump to a match.
        </DialogDescription>
        <ReaderSearchBody
          search={search}
          onSearch={onSearch}
          onPickMatch={(match) => {
            onPickMatch(match);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

interface ReaderSearchBodyProps {
  search: ReaderSearchState | null;
  onSearch: (query: string) => void;
  onPickMatch: (match: ReaderSearchMatch) => void;
}

function ReaderSearchBody({ search, onSearch, onPickMatch }: ReaderSearchBodyProps) {
  const initialQuery = search?.query ?? "";
  const [text, setText] = useState(initialQuery);
  // The last query the parent saw. Searching the same query again after a
  // reopen must not re-run the search or clear the restored results.
  const submittedRef = useRef(initialQuery);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The active row is tagged with the query it belongs to. A new query
  // renders at the top without an effect that writes state on every result
  // update; arrow and hover moves re-tag the selection with the live query.
  const [selection, setSelection] = useState({ query: initialQuery, index: 0 });

  const trimmed = text.trim();
  const results = useMemo(() => flattenMatches(search), [search]);
  const activeQuery = search?.query ?? "";
  const activeIndex =
    selection.query === activeQuery
      ? Math.min(selection.index, Math.max(results.length - 1, 0))
      : 0;
  // A query that differs from the parent's state is between the keystroke
  // and its debounced search; show progress instead of the empty hint.
  const pending = trimmed !== "" && (search === null || search.query !== trimmed);
  const searching = pending || search?.status === "running";
  const activeId = results.length > 0 ? resultId(activeIndex) : undefined;

  const setActiveIndex = (next: number | ((index: number) => number)) => {
    setSelection((prev) => {
      const base = prev.query === activeQuery ? prev.index : 0;
      return {
        query: activeQuery,
        index: typeof next === "function" ? next(base) : next,
      };
    });
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  // Keep the arrow-key selection inside the scroll viewport.
  useEffect(() => {
    if (results.length === 0) return;
    document.getElementById(resultId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results.length]);

  useEffect(() => {
    const next = text.trim();
    if (next === submittedRef.current) return;
    if (next === "") {
      submittedRef.current = "";
      return;
    }
    const timer = window.setTimeout(() => {
      submittedRef.current = next;
      onSearch(next);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, onSearch]);

  const changeText = (next: string) => {
    setText(next);
    const nextTrimmed = next.trim();
    if (nextTrimmed !== submittedRef.current) {
      // Clear stale results as soon as the field no longer matches them; the
      // debounced search below starts the new one.
      submittedRef.current = "";
      onSearch("");
    }
  };

  const pick = (index: number) => {
    const found = results[index];
    if (found !== undefined) onPickMatch(found.match);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(activeIndex);
    }
  };

  const status = statusText(search, trimmed, searching);

  return (
    <>
      <div className="relative flex items-center border-b border-[var(--border)]/60">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-4 size-5 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          data-testid="reader-search-input"
          role="combobox"
          aria-label="Search in book"
          aria-autocomplete="list"
          aria-expanded={results.length > 0}
          aria-controls={results.length > 0 ? "reader-search-results" : undefined}
          aria-activedescendant={activeId}
          type="search"
          placeholder="Search in book"
          value={text}
          onChange={(event) => changeText(event.target.value)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          spellCheck={false}
          className="h-14 rounded-none border-0 bg-transparent pr-4 pl-12 text-lg shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-lg [&::-webkit-search-cancel-button]:appearance-none"
        />
      </div>

      {results.length > 0 ? (
        <div
          id="reader-search-results"
          data-testid="reader-search-results"
          role="listbox"
          aria-label="Search results"
          className="min-h-32 flex-1 overflow-y-auto overscroll-contain [scrollbar-color:var(--reader-scrollbar-thumb,auto)] [scrollbar-gutter:stable] [scrollbar-width:thin]"
        >
          {results.map(({ match, label }, index) => (
            <div
              key={`${label}-${index}`}
              id={resultId(index)}
              role="option"
              aria-selected={index === activeIndex}
              data-testid="reader-search-match"
              // Keep the input focused while clicking; the reader's page-turn
              // shortcuts must stay suppressed until the overlay closes.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => pick(index)}
              className={cn(
                "flex cursor-pointer items-start gap-3 px-4 py-2.5 text-left",
                index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 block text-sm leading-snug">
                  <span className="text-muted-foreground">{match.excerpt.pre}</span>
                  <strong className="font-semibold">{match.excerpt.match}</strong>
                  <span className="text-muted-foreground">{match.excerpt.post}</span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{label}</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div
          data-testid="reader-search-results"
          className="flex min-h-32 flex-1 items-center justify-center px-6 py-8 text-center text-sm text-muted-foreground"
        >
          {emptyMessage(search, trimmed, searching)}
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--border)]/60 px-4 py-2 text-xs text-muted-foreground">
        <span
          role="status"
          data-testid="reader-search-status"
          className="flex min-w-0 items-center gap-1.5"
        >
          {searching && (
            <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin" />
          )}
          <span className="truncate">{status}</span>
        </span>
        <span className="hidden shrink-0 sm:inline">↑↓ navigate · Enter open · Esc close</span>
      </div>
    </>
  );
}

function emptyMessage(
  search: ReaderSearchState | null,
  trimmed: string,
  searching: boolean,
): string {
  if (trimmed === "") return "Search the text of this book.";
  if (searching) return "Searching…";
  return `No matches for “${search?.query ?? trimmed}”`;
}

function statusText(search: ReaderSearchState | null, trimmed: string, searching: boolean): string {
  if (trimmed === "") return "Type to search";
  if (searching || search === null) return "Searching…";
  if (search.totalMatches === 0) return "No matches";
  const matches = `${search.totalMatches} ${search.totalMatches === 1 ? "match" : "matches"}`;
  return search.truncated ? `${matches} · search limit reached` : matches;
}
