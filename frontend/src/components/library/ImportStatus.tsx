import { CheckCircle2, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useImport } from "@/state/importState";

/** Floating, non-blocking report of the last import run. Renders nothing when idle. */
export function ImportStatus() {
  const { phase, summary, failures, dismiss } = useImport();

  if (phase === "idle") return null;

  const failureWord = failures.length === 1 ? "item" : "items";
  const summaryLine =
    phase === "importing"
      ? "Importing…"
      : summary && (summary.imported > 0 || summary.updated > 0)
        ? [
            summary.imported > 0 ? `Imported ${summary.imported} new` : null,
            summary.updated > 0 ? `updated ${summary.updated}` : null,
          ]
            .filter(Boolean)
            .join(", ")
        : "No new books found";

  return (
    <div
      data-testid="import-status"
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-40 max-w-sm rounded-lg border bg-popover p-3 text-popover-foreground shadow-md"
    >
      {phase === "importing" ? (
        <p className="text-sm">{summaryLine}</p>
      ) : (
        <div className="flex items-start gap-2">
          {failures.length > 0 ? (
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-500" />
          ) : (
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-green-600" />
          )}
          <div className="min-w-0 text-sm">
            <p>{summaryLine}</p>
            {failures.length > 0 && (
              <p className="mt-1 text-muted-foreground">
                {failures.length} {failureWord} could not be imported:
                <span
                  className="block truncate"
                  title={`${failures[0]?.path}: ${failures[0]?.error}`}
                >
                  {failures[0]?.path}: {failures[0]?.error}
                </span>
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss import status"
            onClick={dismiss}
          >
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}
