import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useLibrary } from "@/hooks/useLibrary";
import { useAppDispatch } from "@/state/appState";
import { searchBooks } from "./searchBooks";

const MAX_RESULTS = 8;

/**
 * App-wide search (Ctrl/Cmd+K focuses the field via the shortcut registry).
 * Results come from `searchBooks` over the shared library data; picking one
 * opens its detail view. The dropdown derives from the query, so clearing
 * the query (Escape, selection, outside click) always closes it.
 */
export function GlobalSearch() {
  const { books } = useLibrary();
  const dispatch = useAppDispatch();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => searchBooks(books, query).slice(0, MAX_RESULTS), [books, query]);
  const open = query.trim() !== "";

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
      const book = results[activeIndex];
      if (book) openBook(book.id);
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
              results[activeIndex] ? `global-search-option-${results[activeIndex].id}` : undefined
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
            No books match “{query.trim()}”
          </p>
        ) : (
          results.map((book, index) => (
            <button
              key={book.id}
              type="button"
              id={`global-search-option-${book.id}`}
              role="option"
              aria-selected={index === activeIndex}
              data-testid="global-search-result"
              onMouseDown={(event) => {
                // Select before the input blur can close the popover.
                event.preventDefault();
                openBook(book.id);
              }}
              className="w-full rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-selected:bg-accent hover:bg-accent/60"
            >
              <p className="truncate text-sm font-medium">{book.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                {book.author ?? "Unknown author"}
              </p>
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
