import { FORMAT_FILTER_OPTIONS } from "@/lib/formats";
import type { BookFormat } from "@/types/domain";
import { EmptyCollectionState } from "./EmptyCollectionState";
import { EmptyFormatFilterState } from "./EmptyFormatFilterState";
import { NoSearchResultsState } from "./NoSearchResultsState";

interface LibraryEmptyStateProps {
  query: string;
  formats: readonly BookFormat[];
  collectionIsEmpty: boolean;
  onClearSearch: () => void;
  onClearFormats: () => void;
}

/**
 * Picks the empty state that names the actual cause: the search, the format
 * filter, an empty collection, or a section with nothing in it.
 */
export function LibraryEmptyState({
  query,
  formats,
  collectionIsEmpty,
  onClearSearch,
  onClearFormats,
}: LibraryEmptyStateProps) {
  // Ticking every format excludes nothing, so it cannot be the reason a view
  // is empty and should not be blamed for it.
  const formatFilterNarrows = formats.length > 0 && formats.length < FORMAT_FILTER_OPTIONS.length;

  if (query.trim() !== "") {
    return (
      <NoSearchResultsState
        query={query}
        onClearSearch={onClearSearch}
        onClearFormatFilter={formatFilterNarrows ? onClearFormats : undefined}
      />
    );
  }
  if (collectionIsEmpty) return <EmptyCollectionState />;
  if (formatFilterNarrows) {
    return <EmptyFormatFilterState formats={formats} onClear={onClearFormats} />;
  }
  return (
    <p data-testid="empty-section" className="text-sm text-muted-foreground">
      No books in this view yet.
    </p>
  );
}
