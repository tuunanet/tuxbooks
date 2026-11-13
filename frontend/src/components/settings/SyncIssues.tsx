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
import type { SyncIssue } from "@/lib/bridge";
import { formatSyncTime } from "./syncFormat";
import { ViewAllDialog } from "./SyncListDialog";

const SUMMARY_LIMIT = 5;

/** Plain-text block behind Copy details, for a bug report or a forum post. */
export function formatIssueDetails(issue: SyncIssue): string {
  const lines = [
    `Sync issue: ${issue.kind.replaceAll("_", " ")}`,
    `Target: ${issue.target}`,
    issue.fileName ? `File: ${issue.fileName}` : null,
    `Detail: ${issue.detail}`,
    `Updated: ${issue.updatedAt}`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

function isInformational(action: SyncIssue["action"]): boolean {
  return action === "copyDetails" || action === "dismiss";
}

/** Accessible label names the row, so several same-kind rows stay distinct. */
function actionLabel(verb: string, issue: SyncIssue): string {
  const subject = issue.target || issue.kind.replaceAll("_", " ");
  return `${verb} ${subject}`;
}

function IssueRow({
  issue,
  busy,
  onAction,
  onCopyDetails,
  onDismiss,
}: {
  issue: SyncIssue;
  busy: boolean;
  onAction: (issue: SyncIssue) => void;
  onCopyDetails: (issue: SyncIssue) => void;
  onDismiss: (id: number) => void;
}) {
  const primary =
    issue.action === "retry" ? (
      <Button
        size="sm"
        variant="outline"
        onClick={() => onAction(issue)}
        disabled={busy}
        aria-label={actionLabel("Retry", issue)}
        data-testid={`sync-retry-${issue.id}`}
      >
        Retry
      </Button>
    ) : issue.action === "openFolder" ? (
      <Button
        size="sm"
        variant="outline"
        onClick={() => onAction(issue)}
        disabled={busy}
        aria-label={actionLabel("Open folder for", issue)}
        data-testid={`sync-open-folder-${issue.id}`}
      >
        Open folder
      </Button>
    ) : issue.action === "copyDetails" ? (
      <Button
        size="sm"
        variant="outline"
        onClick={() => onAction(issue)}
        disabled={busy}
        aria-label={actionLabel("Copy details for", issue)}
        data-testid={`sync-copy-details-${issue.id}`}
      >
        Copy details
      </Button>
    ) : (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onDismiss(issue.id)}
        disabled={busy}
        aria-label={actionLabel("Dismiss", issue)}
        data-testid={`sync-dismiss-${issue.id}`}
      >
        Dismiss
      </Button>
    );

  return (
    <li className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{issue.kind.replaceAll("_", " ")}</p>
          {issue.target ? <p className="mt-1 break-words text-xs">{issue.target}</p> : null}
          <p className="mt-1 break-words text-muted-foreground">{issue.detail}</p>
          {issue.nextAutoRetryAt ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Next retry {formatSyncTime(issue.nextAutoRetryAt)}
            </p>
          ) : null}
          {issue.fileName ? (
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {issue.fileName}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">{formatSyncTime(issue.updatedAt)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {primary}
          {issue.action !== "copyDetails" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onCopyDetails(issue)}
              disabled={busy}
              aria-label={actionLabel("Copy details for", issue)}
              data-testid={`sync-copy-details-${issue.id}`}
            >
              Copy details
            </Button>
          ) : null}
          {issue.action === "copyDetails" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDismiss(issue.id)}
              disabled={busy}
              aria-label={actionLabel("Dismiss", issue)}
              data-testid={`sync-dismiss-${issue.id}`}
            >
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function SyncIssuesSection({
  issues,
  total,
  busy,
  onAction,
  onCopyDetails,
  onDismiss,
  onDismissAll,
}: {
  issues: SyncIssue[];
  total: number;
  busy: boolean;
  onAction: (issue: SyncIssue) => void;
  onCopyDetails: (issue: SyncIssue) => void;
  onDismiss: (id: number) => void;
  onDismissAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDismissAll, setConfirmDismissAll] = useState(false);
  const summary = issues.slice(0, SUMMARY_LIMIT);
  // `total` is the engine's attention-worthy count (ADR 0017 D4): rows the
  // sweep still owns — auto-retry on, budget under the cap — are work in
  // progress and stay out of it. The list renders from the fetched rows, so
  // an in-flight retry stays visible even while nothing here needs a human.
  const hasRows = issues.length > 0;
  const hasInformational = issues.some((issue) => isInformational(issue.action));
  const groups = useMemo(() => {
    const map = new Map<string, SyncIssue[]>();
    for (const issue of issues) {
      const list = map.get(issue.kind) ?? [];
      list.push(issue);
      map.set(issue.kind, list);
    }
    return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [issues]);
  const truncated = total > issues.length;

  return (
    <section className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-medium">Sync issues</h3>
          {!hasRows ? <p className="mt-2 text-sm text-muted-foreground">No sync issues.</p> : null}
        </div>
        {hasInformational ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="sync-issues-dismiss-all"
            onClick={() => setConfirmDismissAll(true)}
            disabled={busy}
          >
            Dismiss all
          </Button>
        ) : null}
      </div>

      {hasRows ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {issues.length > SUMMARY_LIMIT ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="sync-issues-view-all"
                onClick={() => setOpen(true)}
              >
                View all {issues.length}
              </Button>
            ) : null}
            {truncated ? (
              <p className="text-xs text-muted-foreground">
                Showing first {issues.length} of {total}.
              </p>
            ) : null}
          </div>
          <ul data-testid="sync-issues" className="mt-3 flex flex-col gap-3">
            {summary.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                busy={busy}
                onAction={onAction}
                onCopyDetails={onCopyDetails}
                onDismiss={onDismiss}
              />
            ))}
          </ul>
        </>
      ) : null}

      <ViewAllDialog
        open={open}
        onOpenChange={setOpen}
        title="Sync issues"
        description="Grouped by kind. Retry repairs what the app can repair, Open folder shows where a rejected file lives, and Dismiss only hides informational rows."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            {hasInformational ? (
              <Button
                variant="outline"
                data-testid="sync-issues-dismiss-all-dialog"
                onClick={() => {
                  setOpen(false);
                  setConfirmDismissAll(true);
                }}
                disabled={busy}
              >
                Dismiss informational
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {groups.map(([kind, rows]) => (
            <div key={kind}>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {kind.replaceAll("_", " ")} ({rows.length})
              </h4>
              <ul className="flex flex-col gap-2">
                {rows.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    busy={busy}
                    onAction={onAction}
                    onCopyDetails={onCopyDetails}
                    onDismiss={onDismiss}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </ViewAllDialog>

      <Dialog open={confirmDismissAll} onOpenChange={setConfirmDismissAll}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Dismiss informational sync issues?</DialogTitle>
            <DialogDescription>
              This hides the informational rows. Issues with a Retry or Open folder action stay
              listed until the condition clears, so a fixable problem is never hidden.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDismissAll(false)}>
              Cancel
            </Button>
            <Button
              data-testid="sync-issues-dismiss-all-confirm"
              onClick={() => {
                setConfirmDismissAll(false);
                onDismissAll();
              }}
              disabled={busy}
            >
              Dismiss all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
