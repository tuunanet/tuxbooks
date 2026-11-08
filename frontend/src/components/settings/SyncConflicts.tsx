import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SyncConflict, SyncConflictResolution } from "@/lib/bridge";
import { compareConflicts, ConflictGroupView, groupConflicts } from "./SyncConflictRows";
import { ViewAllDialog } from "./SyncListDialog";

const SUMMARY_LIMIT = 5;

export function SyncConflictsSection({
  conflicts,
  total,
  deviceId,
  busy,
  onResolve,
  onKeepAll,
}: {
  conflicts: SyncConflict[];
  total: number;
  deviceId: string | null;
  busy: boolean;
  onResolve: (id: number, resolution: SyncConflictResolution) => void;
  onKeepAll: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmKeepAll, setConfirmKeepAll] = useState(false);
  const [deferred, setDeferred] = useState<Set<number>>(() => new Set());

  const visible = useMemo(
    () => conflicts.filter((conflict) => !deferred.has(conflict.id)),
    [conflicts, deferred],
  );
  const deferredRows = useMemo(
    () => conflicts.filter((conflict) => deferred.has(conflict.id)),
    [conflicts, deferred],
  );
  const sorted = useMemo(() => [...visible].sort(compareConflicts), [visible]);
  const summaryGroups = useMemo(() => groupConflicts(sorted.slice(0, SUMMARY_LIMIT)), [sorted]);
  const allGroups = useMemo(() => groupConflicts(sorted), [sorted]);
  const deferredCount = deferredRows.length;
  const loadedCount = conflicts.length;
  const truncated = total > loadedCount;

  const keepAll = () => {
    setConfirmKeepAll(false);
    onKeepAll(visible.map((conflict) => conflict.id));
  };

  return (
    <section data-testid="sync-conflicts" className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-medium">Conflicts to review</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            <span data-testid="sync-conflicts-count">{total}</span> open. The current winner is
            already applied.
          </p>
        </div>
        {total > 0 ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="sync-conflicts-keep-all"
            onClick={() => setConfirmKeepAll(true)}
            disabled={busy || visible.length === 0}
          >
            Keep current winner
          </Button>
        ) : null}
      </div>

      {loadedCount === 0 ? (
        <p data-testid="sync-conflicts-empty" className="mt-3 text-sm text-muted-foreground">
          No conflicts to review.
        </p>
      ) : (
        <>
          {deferredCount > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {deferredCount} {deferredCount === 1 ? "conflict is" : "conflicts are"} set aside for
              now.{" "}
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0 text-xs"
                data-testid="sync-conflicts-show-deferred"
                onClick={() => setDeferred(new Set())}
              >
                Show
              </Button>
            </p>
          ) : null}

          {visible.length > SUMMARY_LIMIT || truncated ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {visible.length > SUMMARY_LIMIT ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="sync-conflicts-view-all"
                  onClick={() => setOpen(true)}
                >
                  View all {total}
                </Button>
              ) : null}
              {truncated ? (
                <p className="text-xs text-muted-foreground">
                  Showing first {loadedCount} of {total}.
                </p>
              ) : null}
            </div>
          ) : null}

          {visible.length === 0 ? (
            <p
              data-testid="sync-conflicts-all-deferred"
              className="mt-3 text-sm text-muted-foreground"
            >
              Every conflict is set aside for now.
            </p>
          ) : (
            <div data-testid="sync-conflicts-list" className="mt-3 flex flex-col gap-4">
              {summaryGroups.map((group) => (
                <ConflictGroupView
                  key={group.key}
                  group={group}
                  deviceId={deviceId}
                  busy={busy}
                  idPrefix="summary"
                  onResolve={onResolve}
                  onLater={(id) => setDeferred((current) => new Set(current).add(id))}
                />
              ))}
            </div>
          )}
        </>
      )}

      <ViewAllDialog
        open={open}
        onOpenChange={setOpen}
        title="Conflicts to review"
        description="Grouped by book. Delete and edit conflicts come first, then whole-entity conflicts, then single fields. The current winner is already applied until you choose."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              variant="outline"
              data-testid="sync-conflicts-keep-all-dialog"
              onClick={() => {
                setOpen(false);
                setConfirmKeepAll(true);
              }}
              disabled={busy || visible.length === 0}
            >
              Keep current winner
            </Button>
          </>
        }
      >
        {truncated ? (
          <p className="mb-3 text-xs text-muted-foreground">
            Showing first {loadedCount} of {total}.
          </p>
        ) : null}
        <div className="flex flex-col gap-4">
          {allGroups.map((group) => (
            <ConflictGroupView
              key={group.key}
              group={group}
              deviceId={deviceId}
              busy={busy}
              idPrefix="dialog"
              onResolve={onResolve}
              onLater={(id) => setDeferred((current) => new Set(current).add(id))}
            />
          ))}
        </div>
      </ViewAllDialog>

      <Dialog open={confirmKeepAll} onOpenChange={setConfirmKeepAll}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Keep the current winner for every conflict?</DialogTitle>
            <DialogDescription>
              This closes the {visible.length} shown{" "}
              {visible.length === 1 ? "conflict" : "conflicts"} and keeps the value that is already
              applied. No other conflict changes, and other devices keep the same winner.
            </DialogDescription>
          </DialogHeader>
          {truncated ? (
            <p className="text-xs text-muted-foreground">
              The list loads the first {loadedCount} of {total} conflicts; the rest stay open.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmKeepAll(false)}>
              Cancel
            </Button>
            <Button
              data-testid="sync-conflicts-keep-all-confirm"
              onClick={keepAll}
              disabled={busy || visible.length === 0}
            >
              Keep current winner
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
