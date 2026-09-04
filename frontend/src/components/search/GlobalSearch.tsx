import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { searchLibrary } from "@/lib/tauri";
import { useAppDispatch } from "@/state/appState";
import type { SearchHit } from "@/types/domain";
import { splitSnippet } from "./snippet";

const MAX_RESULTS = 8;
const DEBOUNCE_MS = 150;

/**
 * App-wide search (Ctrl/Cmd+K focuses the field via the shortcut registry).
 * Results come from the backend FTS5 index (`search_books`), debounced per
 * keystroke; only the latest response is rendered. Picking one opens its
 * detail view. The dropdown derives from the query, so clearing the query
 * (Escape, selection, outside click) always closes it.
 */
export function GlobalSearch() {
  const dispatch = useAppDispatch();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // Monotonic request id: a slow earlier response never overwrites a newer one.
  const requestRef = useRef(0);

  const trimmed = query.trim();
  const open = trimmed !== "";
  const results = open ? hits.slice(0, MAX_RESULTS) : [];

  useEffect(() => {
    if (!open) return;
    const id = ++requestRef.current;
    const timer = setTimeout(() => {
      searchLibrary(trimmed)
        .then((found) => {
          if (requestRef.current === id) {
            setHits(found);
            setActiveIndex(0);
          }
        })
        .catch(() => {
          if (requestRef.current === id) setHits([]);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, trimmed]);

  const setQueryAndReset = (next: string) => {
    setQuery(next);
    setActiveIndex(0);
  };

  const openBook = (bookId: number) => {
    dispatch({ type: "open-book-detail", bookId });
    setQueryAndReset("");
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = results[activeIndex];
      if (hit) openBook(hit.bookId);
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => !next && setQueryAndReset("")}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            data-testid="global-search"
            data-shortcut="global-search"
            role="combobox"
            aria-expanded={open}
            aria-controls="global-search-results"
            aria-activedescendant={
              results[activeIndex]
                ? `global-search-option-${results[activeIndex].bookId}`
                : undefined
            }
            aria-label="Search library"
            type="search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQueryAndReset(event.target.value)}
            onKeyDown={handleKeyDown}
            className="pl-8"
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        id="global-search-results"
        role="listbox"
        aria-label="Search results"
        align="start"
        sideOffset={6}
        className="max-h-72 w-(--radix-popover-trigger-width) gap-1 overflow-y-auto p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {results.length === 0 ? (
          <p
            role="status"
            data-testid="global-search-empty"
            className="px-2 py-3 text-sm text-muted-foreground"
          >
            No books match “{trimmed}”
          </p>
        ) : (
          results.map((hit, index) => {
            const snippet = splitSnippet(hit.snippet);
            return (
              <button
                key={hit.bookId}
                type="button"
                id={`global-search-option-${hit.bookId}`}
                role="option"
                aria-selected={index === activeIndex}
                data-testid="global-search-result"
                onMouseDown={(event) => {
                  // Select before the input blur can close the popover.
                  event.preventDefault();
                  openBook(hit.bookId);
                }}
                className="w-full rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-selected:bg-accent hover:bg-accent/60"
              >
                <p className="truncate text-sm font-medium">{hit.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {hit.author ?? "Unknown author"}
                </p>
                {snippet !== null && (
                  <p
                    data-testid="global-search-snippet"
                    className="truncate text-xs text-muted-foreground"
                  >
                    {snippet.pre}
                    <strong className="font-medium text-foreground">{snippet.match}</strong>
                    {snippet.post}
                  </p>
                )}
              </button>
            );
          })
        )}
      </PopoverContent>
    </Popover>
  );
}
