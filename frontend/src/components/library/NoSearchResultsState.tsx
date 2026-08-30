import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NoSearchResultsStateProps {
  query: string;
  onClearSearch: () => void;
}

export function NoSearchResultsState({ query, onClearSearch }: NoSearchResultsStateProps) {
  return (
    <div
      data-testid="no-search-results"
      className="flex h-64 flex-col items-center justify-center gap-3 text-center"
    >
      <SearchX className="h-12 w-12 text-muted-foreground" />
      <h3 className="text-lg font-semibold">No results for “{query.trim()}”</h3>
      <p className="max-w-sm text-sm text-muted-foreground">
        Try a different title, author, or publisher.
      </p>
      <Button variant="outline" size="sm" onClick={onClearSearch}>
        Clear search
      </Button>
    </div>
  );
}
