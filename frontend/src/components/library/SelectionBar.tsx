import { Button } from "@/components/ui/button";

interface SelectionBarProps {
  count: number;
  onClear: () => void;
}

/**
 * Slim bar above the library grid/list while a multi-selection is active.
 * It shows how many books are in the selection and a Clear control to start
 * over. Below two books the blue selection on the cards already says it, so
 * the bar stays out of the way.
 */
export function SelectionBar({ count, onClear }: SelectionBarProps) {
  if (count < 2) return null;
  return (
    <div
      data-testid="selection-bar"
      role="status"
      aria-live="polite"
      className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-library-selection/40 bg-library-selection/10 px-3 py-1.5 text-sm"
    >
      <span data-testid="selection-count">{count} books selected</span>
      <Button variant="ghost" size="sm" data-testid="selection-clear" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
