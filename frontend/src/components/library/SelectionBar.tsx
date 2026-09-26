import { Button } from "@/components/ui/button";

interface SelectionBarProps {
  count: number;
  /** Transient result of the last bulk operation, e.g. after a bulk remove. */
  message?: string | null;
  onClear: () => void;
}

/**
 * Slim bar above the library grid/list while a multi-selection is active.
 * It shows how many books are in the selection and a Clear control to start
 * over, plus a transient note after a bulk operation — that note is what the
 * bar shows once the operation clears the selection. Below two books and
 * without a note the blue selection on the cards already says it, so the bar
 * stays out of the way.
 */
export function SelectionBar({ count, message = null, onClear }: SelectionBarProps) {
  if (count < 2 && message === null) return null;
  return (
    <div
      data-testid="selection-bar"
      role="status"
      aria-live="polite"
      className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-library-selection/40 bg-library-selection/10 px-3 py-1.5 text-sm"
    >
      <span className="flex items-center gap-3">
        {count >= 2 && <span data-testid="selection-count">{count} books selected</span>}
        {message !== null && <span data-testid="selection-message">{message}</span>}
      </span>
      {count >= 2 && (
        <Button variant="ghost" size="sm" data-testid="selection-clear" onClick={onClear}>
          Clear
        </Button>
      )}
    </div>
  );
}
