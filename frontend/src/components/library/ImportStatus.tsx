import { CheckCircle2, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useImport,
  type ImportFailure,
  type ImportPhase,
  type ImportSummary,
} from "@/state/importState";

function summaryLineFor(phase: ImportPhase, summary: ImportSummary | null): string {
  if (phase === "importing") return "Importing…";
  if (summary?.cancelled) return "Import cancelled";
  return countsLine(summary);
}

function countsLine(summary: ImportSummary | null): string {
  if (!summary) return "No new books found";
  const parts = [
    summary.imported > 0 ? `Imported ${summary.imported} new` : null,
    summary.updated > 0 ? `updated ${summary.updated}` : null,
    summary.skipped > 0 ? `${summary.skipped} already in your library` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "No new books found";
}

function FolderNotices({ summary }: { summary: ImportSummary | null }) {
  if (!summary || summary.cancelled) return null;
  return (
    <>
      {summary.watched.map((folder) => (
        <p key={folder} className="mt-1 truncate text-muted-foreground" title={folder}>
          Watching {folder}
        </p>
      ))}
      {summary.covered.map((folder) => (
        <p key={folder} className="mt-1 truncate text-muted-foreground" title={folder}>
          Already covered by a folder you watch: {folder}
        </p>
      ))}
    </>
  );
}

function FailureLine({ failures }: { failures: ImportFailure[] }) {
  if (failures.length === 0) return null;
  const failureWord = failures.length === 1 ? "item" : "items";
  return (
    <p className="mt-1 text-muted-foreground">
      {failures.length} {failureWord} could not be imported:
      <span className="block truncate" title={`${failures[0]?.path}: ${failures[0]?.error}`}>
        {failures[0]?.path}: {failures[0]?.error}
      </span>
    </p>
  );
}

/** Floating, non-blocking report of the last import run. Renders nothing when idle. */
export function ImportStatus() {
  const { phase, summary, failures, dismiss } = useImport();

  if (phase === "idle") return null;

  const summaryLine = summaryLineFor(phase, summary);

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
            <FolderNotices summary={summary} />
            <FailureLine failures={failures} />
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
