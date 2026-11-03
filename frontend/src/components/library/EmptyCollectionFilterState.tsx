import { FilterX } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyCollectionFilterStateProps {
  onClearFilters: () => void;
}

/** A collection place whose members exist but the view filters hide them. */
export function EmptyCollectionFilterState({ onClearFilters }: EmptyCollectionFilterStateProps) {
  return (
    <div
      data-testid="empty-collection-filtered"
      className="flex h-64 flex-col items-center justify-center gap-3 text-center"
    >
      <FilterX className="h-12 w-12 text-muted-foreground" />
      <h3 className="text-lg font-semibold">No books match this filter</h3>
      <p className="max-w-sm text-sm text-muted-foreground">
        These collections have books, but the search or format filter hides them.
      </p>
      <Button variant="outline" size="sm" onClick={onClearFilters}>
        Clear filters
      </Button>
    </div>
  );
}
