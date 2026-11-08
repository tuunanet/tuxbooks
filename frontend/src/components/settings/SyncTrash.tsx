import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { SyncTrashEntry } from "@/lib/bridge";
import { formatSyncTime } from "./syncFormat";
import { ViewAllDialog } from "./SyncListDialog";

const SUMMARY_LIMIT = 5;

function TrashRow({
  entry,
  busy,
  onRestore,
}: {
  entry: SyncTrashEntry;
  busy: boolean;
  onRestore: (id: number) => void;
}) {
  return (
    <li className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{entry.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {entry.kind} · deleted {formatSyncTime(entry.deletedAt)} · restorable until{" "}
            {formatSyncTime(entry.expiresAt)}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRestore(entry.id)}
          data-testid={`sync-restore-${entry.id}`}
          disabled={busy}
        >
          Restore
        </Button>
      </div>
    </li>
  );
}

export function SyncTrashSection({
  entries,
  total,
  busy,
  onRestore,
}: {
  entries: SyncTrashEntry[];
  total: number;
  busy: boolean;
  onRestore: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = entries.slice(0, SUMMARY_LIMIT);
  const truncated = total > entries.length;

  return (
    <section className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-medium">Recently deleted</h3>
          {total === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Deleted annotations and collections stay restorable for 30 days.
            </p>
          ) : null}
        </div>
        {entries.length > SUMMARY_LIMIT ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="sync-trash-view-all"
            onClick={() => setOpen(true)}
          >
            View all {entries.length}
          </Button>
        ) : null}
      </div>

      {entries.length > 0 ? (
        <>
          {truncated ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing first {entries.length} of {total}.
            </p>
          ) : null}
          <ul data-testid="sync-trash" className="mt-3 flex flex-col gap-3">
            {summary.map((entry) => (
              <TrashRow key={entry.id} entry={entry} busy={busy} onRestore={onRestore} />
            ))}
          </ul>
        </>
      ) : null}

      <ViewAllDialog
        open={open}
        onOpenChange={setOpen}
        title="Recently deleted"
        description="Deleted annotations and collections stay restorable for 30 days."
        footer={
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        }
      >
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => (
            <TrashRow key={entry.id} entry={entry} busy={busy} onRestore={onRestore} />
          ))}
        </ul>
      </ViewAllDialog>
    </section>
  );
}
