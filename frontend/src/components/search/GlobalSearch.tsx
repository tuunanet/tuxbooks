import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Folder, Search, type LucideIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useLibrary } from "@/hooks/useLibrary";
import { searchLibrary } from "@/lib/bridge";
import { useAppDispatch } from "@/state/appState";
import type { CollectionSummary, SearchHit } from "@/types/domain";
import { buildPaletteResults, type PaletteItem } from "./palette";
import { splitSnippet } from "./snippet";

const DEBOUNCE_MS = 150;

function itemOptionId(item: PaletteItem): string {
  return item.kind === "collection"
    ? `global-search-option-collection-${item.collection.id}`
    : `global-search-option-book-${item.hit.bookId}`;
}

interface ResultRowProps {
  id: string;
  selected: boolean;
  icon: LucideIcon;
  title: string;
  meta: string;
  snippet?: React.ReactNode;
  onPick: () => void;
}

/** One palette row: a type icon, a title, and its secondary metadata. */
function ResultRow({ id, selected, icon: Icon, title, meta, snippet, onPick }: ResultRowProps) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      data-testid="global-search-result"
      onMouseDown={(event) => {
        // Select before the input blur can close the popover.
        event.preventDefault();
        onPick();
      }}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-selected:bg-accent hover:bg-accent/60"
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{meta}</span>
        {snippet != null && (
          <span
            data-testid="global-search-snippet"
            className="block truncate text-xs text-muted-foreground"
          >
            {snippet}
          </span>
        )}
      </span>
    </button>
  );
}

function GroupLabel({ id, children }: { id: string; children: string }) {
  return (
    <p
      id={id}
      className="px-2 pt-1 pb-0.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
    >
      {children}
    </p>
  );
}

function collectionMeta(collection: CollectionSummary): string {
  const count = collection.bookIds.length;
  return `${count} ${count === 1 ? "book" : "books"}`;
}

/**
 * App-wide command palette (Ctrl/Cmd+K focuses the field via the shortcut
 * registry). Collection matches are client-side over the loaded summaries;
 * book matches come from the backend FTS5 index (`search_books`), debounced
 * per keystroke with only the latest response rendered. Results are grouped
 * Collections then Books, and one highlight moves through both. Picking a
 * collection replaces the current place; picking a book opens its detail.
 * The dropdown derives from the query, so clearing it (Escape, selection,
 * outside click) always closes it.
 */
export function GlobalSearch() {
  const dispatch = useAppDispatch();
  const { collections } = useLibrary();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // Monotonic request id: a slow earlier response never overwrites a newer one.
  const requestRef = useRef(0);

  const trimmed = query.trim();
  const open = trimmed !== "";
  const groups = useMemo(
    () =>
      open
        ? buildPaletteResults(collections, hits, trimmed)
        : { collections: [], books: [], items: [] as PaletteItem[] },
    [collections, hits, open, trimmed],
  );
  const items = groups.items;
  // The stored index can lag a shorter result set; clamp at read time.
  const highlighted = items.length === 0 ? -1 : Math.min(activeIndex, items.length - 1);

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

  // Keep the highlighted row inside the scroll viewport.
  useEffect(() => {
    const item = items[highlighted];
    if (!item) return;
    document.getElementById(itemOptionId(item))?.scrollIntoView({ block: "nearest" });
  }, [highlighted, items]);

  const setQueryAndReset = (next: string) => {
    setQuery(next);
    setActiveIndex(0);
  };

  const openBook = (bookId: number) => {
    dispatch({ type: "open-book-detail", bookId });
    setQueryAndReset("");
  };

  const openCollection = (collectionId: number) => {
    // The same place entry a sidebar replace-click uses, so the section-scoped
    // query and book selection reset together.
    dispatch({ type: "select-section", section: { kind: "collection", ids: [collectionId] } });
    setQueryAndReset("");
  };

  const pick = (item: PaletteItem) => {
    if (item.kind === "collection") openCollection(item.collection.id);
    else openBook(item.hit.bookId);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (items.length > 0) {
        setActiveIndex((index) => Math.min(index + 1, items.length - 1));
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length > 0) {
        setActiveIndex((index) => Math.max(index - 1, 0));
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[highlighted];
      if (item) pick(item);
    }
  };

  const activeItem = items[highlighted];
  const collectionOffset = groups.collections.length;

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
            aria-activedescendant={activeItem ? itemOptionId(activeItem) : undefined}
            aria-label="Search library or collections"
            type="search"
            placeholder="Search library or collections"
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
        {items.length === 0 ? (
          <p
            role="status"
            data-testid="global-search-empty"
            className="px-2 py-3 text-sm text-muted-foreground"
          >
            No books or collections match “{trimmed}”
          </p>
        ) : (
          <>
            {groups.collections.length > 0 && (
              <div
                role="group"
                aria-labelledby="global-search-collections-label"
                className="flex flex-col gap-0.5"
              >
                <GroupLabel id="global-search-collections-label">Collections</GroupLabel>
                {groups.collections.map((collection, index) => (
                  <ResultRow
                    key={collection.id}
                    id={itemOptionId({ kind: "collection", collection })}
                    selected={highlighted === index}
                    icon={Folder}
                    title={collection.name}
                    meta={collectionMeta(collection)}
                    onPick={() => openCollection(collection.id)}
                  />
                ))}
              </div>
            )}
            {groups.books.length > 0 && (
              <div
                role="group"
                aria-labelledby="global-search-books-label"
                className="flex flex-col gap-0.5"
              >
                <GroupLabel id="global-search-books-label">Books</GroupLabel>
                {groups.books.map((hit, index) => {
                  const snippet = splitSnippet(hit.snippet);
                  return (
                    <ResultRow
                      key={hit.bookId}
                      id={itemOptionId({ kind: "book", hit })}
                      selected={highlighted === collectionOffset + index}
                      icon={BookOpen}
                      title={hit.title}
                      meta={hit.author ?? "Unknown author"}
                      snippet={
                        snippet === null ? null : (
                          <>
                            {snippet.pre}
                            <strong className="font-medium text-foreground">{snippet.match}</strong>
                            {snippet.post}
                          </>
                        )
                      }
                      onPick={() => openBook(hit.bookId)}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
