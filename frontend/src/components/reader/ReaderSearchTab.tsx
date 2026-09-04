import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { ReaderSearchMatch, ReaderSearchState } from "./searchModel";
interface ReaderSearchTabProps {
  /** Current search state; null when no search has run (or was cleared). */
  search: ReaderSearchState | null;
  /** Starts/clears a search for the current book (debounced by this tab). */
  onSearch: (query: string) => void;
  /** Navigates to a match; the drawer stays open for the next hit. */
  onPickMatch: (match: ReaderSearchMatch) => void;
}

/**
 * In-book search panel for the navigation drawer, shared by EPUB (CFI
 * matches, grouped by chapter) and PDF (page matches). The query input
 * debounces into `onSearch`; results stream in while `status` is running.
 */
export function ReaderSearchTab({ search, onSearch, onPickMatch }: ReaderSearchTabProps) {
  const [text, setText] = useState(search?.query ?? "");
  // The last query the parent saw; reopening the drawer with results must
  // not re-run the same search.
  const submittedRef = useRef(search?.query ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The search input is the tab's primary control — focus it whenever the
  // tab mounts (drawer opened onto Search, or the tab selected).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = text.trim();
      if (trimmed === submittedRef.current) return;
      submittedRef.current = trimmed;
      onSearch(trimmed);
    }, 300);
    return () => clearTimeout(timer);
  }, [text, onSearch]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 px-3 py-3">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          data-testid="reader-search-input"
          aria-label="Search in book"
          type="search"
          placeholder="Search in book"
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="pl-8"
        />
      </div>

      {search === null ? (
        <p className="px-1 text-sm text-muted-foreground">Type to search the text of this book.</p>
      ) : (
        <>
          <p
            data-testid="reader-search-status"
            role="status"
            className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
          >
            {search.status === "running" && (
              <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
            )}
            {search.totalMatches === 0
              ? search.status === "running"
                ? "Searching…"
                : `No matches for “${search.query}”`
              : `${search.totalMatches} ${search.totalMatches === 1 ? "match" : "matches"}`}
          </p>
          <div data-testid="reader-search-results" className="min-h-0 flex-1 overflow-y-auto pr-1">
            {search.groups.map((group, groupIndex) => (
              <div key={`${group.label}-${groupIndex}`} className="mb-2">
                <p className="px-1 py-1 text-xs font-medium text-muted-foreground">
                  {group.label} ({group.matches.length})
                </p>
                {group.matches.map((match, matchIndex) => (
                  <button
                    key={`${group.label}-${matchIndex}`}
                    type="button"
                    data-testid="reader-search-match"
                    onClick={() => onPickMatch(match)}
                    className="block w-full rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="text-muted-foreground">{match.excerpt.pre}</span>
                    <strong className="font-semibold">{match.excerpt.match}</strong>
                    <span className="text-muted-foreground">{match.excerpt.post}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
