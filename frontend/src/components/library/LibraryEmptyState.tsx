import { FORMAT_FILTER_OPTIONS } from "@/lib/formats";
import type { LibrarySection } from "@/state/appState";
import type { BookFormat } from "@/types/domain";
import type { CollectionEmptyKind } from "./sections";
import { EmptyCollectionFilterState } from "./EmptyCollectionFilterState";
import { EmptyCollectionState } from "./EmptyCollectionState";
import { EmptyFormatFilterState } from "./EmptyFormatFilterState";
import { EmptyMultiCollectionState } from "./EmptyMultiCollectionState";
import { NoSearchResultsState } from "./NoSearchResultsState";

interface LibraryEmptyStateProps {
  query: string;
  formats: readonly BookFormat[];
  section: LibrarySection;
  collectionEmpty: CollectionEmptyKind;
  onClearSearch: () => void;
  onClearFormats: () => void;
  onShowAllBooks: () => void;
}

/**
 * Picks the empty state that names the actual cause: the search, the format
 * filter, an empty collection, an empty union of collections, or a section
 * with nothing in it.
 */
export function LibraryEmptyState({
  query,
  formats,
  section,
  collectionEmpty,
  onClearSearch,
  onClearFormats,
  onShowAllBooks,
}: LibraryEmptyStateProps) {
  // Ticking every format excludes nothing, so it cannot be the reason a view
  // is empty and should not be blamed for it.
  const formatFilterNarrows = formats.length > 0 && formats.length < FORMAT_FILTER_OPTIONS.length;
  const filtersHideMembers = query.trim() !== "" || formatFilterNarrows;

  if (section.kind === "collection") {
    if (collectionEmpty === "empty") return <EmptyCollectionState />;
    if (collectionEmpty === "empty-multi") {
      return <EmptyMultiCollectionState onShowAllBooks={onShowAllBooks} />;
    }
    // Members exist but the view filters hide them; name the filter rather
    // than calling the collections empty.
    if (filtersHideMembers) {
      return (
        <EmptyCollectionFilterState
          onClearFilters={() => {
            onClearSearch();
            onClearFormats();
          }}
        />
      );
    }
  }

  if (query.trim() !== "") {
    return (
      <NoSearchResultsState
        query={query}
        onClearSearch={onClearSearch}
        onClearFormatFilter={formatFilterNarrows ? onClearFormats : undefined}
      />
    );
  }
  if (formatFilterNarrows) {
    return <EmptyFormatFilterState formats={formats} onClear={onClearFormats} />;
  }
  return (
    <p data-testid="empty-section" className="text-sm text-muted-foreground">
      No books in this view yet.
    </p>
  );
}
