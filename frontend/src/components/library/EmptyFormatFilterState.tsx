import { FilterX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNames } from "@/lib/formats";
import type { BookFormat } from "@/types/domain";

interface EmptyFormatFilterStateProps {
  formats: readonly BookFormat[];
  onClear: () => void;
}

/** The format filter matched nothing; offer the way back to every format. */
export function EmptyFormatFilterState({ formats, onClear }: EmptyFormatFilterStateProps) {
  return (
    <div
      data-testid="empty-format-filter"
      className="flex h-64 flex-col items-center justify-center gap-3 text-center"
    >
      <FilterX className="h-12 w-12 text-muted-foreground" />
      <h3 className="text-lg font-semibold">No {formatNames(formats)} books in this view</h3>
      <p className="max-w-sm text-sm text-muted-foreground">
        Other formats may still have books here.
      </p>
      <Button variant="outline" size="sm" onClick={onClear}>
        Clear format filter
      </Button>
    </div>
  );
}
