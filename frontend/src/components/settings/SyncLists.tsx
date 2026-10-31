import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type {
  SyncConflict,
  SyncConflictResolution,
  SyncIssue,
  SyncTrashEntry,
  WaitingBook,
} from "@/lib/bridge";
import { formatSyncTime, formatSyncWall } from "./syncFormat";

const SUMMARY_LIMIT = 5;
const VALUE_LIMIT = 80;

function truncate(value: string): string {
  return value.length > VALUE_LIMIT ? `${value.slice(0, VALUE_LIMIT - 1)}…` : value;
}

/** Objects and long strings stay compact so two values fit side by side. */
function formatConflictValue(value: unknown): string {
  if (value === null || value === undefined) return "Empty";
  if (typeof value === "string") return value.length === 0 ? "Empty" : truncate(value);
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json && json !== "{}" ? truncate(json) : "Empty";
  }
  return truncate(String(value));
}

/** The full value behind a truncated row, for hover text. */
function fullValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? undefined;
}

function objectFieldCount(value: unknown): number | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).length
    : null;
}

type ConflictChoice = {
  thisDevice: SyncConflictResolution;
  other: SyncConflictResolution;
  thisLabel: string;
  otherLabel: string;
};

/**
 * The applied winner is not always the local value. A local winner means
 * "Keep this device" keeps the winner; a local loser means it republishes the
 * loser. The opposite button always takes the opposite action.
 */
function conflictChoices(conflict: SyncConflict, deviceId: string | null): ConflictChoice {
  const winnerLocal = Boolean(deviceId) && conflict.winnerDeviceId === deviceId;
  const loserLocal = Boolean(deviceId) && conflict.loserDeviceId === deviceId;
  const relative = winnerLocal || loserLocal;
  const thisDevice: SyncConflictResolution =
    loserLocal && !winnerLocal ? "apply_loser" : "keep_winner";
  return {
    thisDevice,
    other: thisDevice === "keep_winner" ? "apply_loser" : "keep_winner",
    thisLabel: relative ? "Keep this device" : "Keep winner",
    otherLabel: relative ? "Keep other" : "Apply other",
  };
}

function fieldPriority(field: string): number {
  if (field === "__deleted__" || field === "__restore__") return 0;
  if (field === "__entity__") return 1;
  return 2;
}

function compareConflicts(left: SyncConflict, right: SyncConflict): number {
  const priority = fieldPriority(left.field) - fieldPriority(right.field);
  if (priority !== 0) return priority;
  if (left.createdAt !== right.createdAt) return right.createdAt.localeCompare(left.createdAt);
  return right.id - left.id;
}

type ConflictGroup = {
  key: string;
  title: string;
  author: string | null;
  rows: SyncConflict[];
};

/** Delete/edit rows lead, then whole entities, then plain fields; newest first. */
function groupConflicts(conflicts: SyncConflict[]): ConflictGroup[] {
  const groups = new Map<string, ConflictGroup>();
  for (const conflict of [...conflicts].sort(compareConflicts)) {
    const key = conflict.bookUid ?? `title:${conflict.bookTitle ?? "unknown"}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: conflict.bookTitle ?? "Unknown book",
        author: conflict.bookAuthor,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(conflict);
  }
  return [...groups.values()];
}

function deviceLabel(name: string, id: string, deviceId: string | null): string {
  return deviceId && id === deviceId ? `${name} (this device)` : name;
}

function ConflictValue({ value }: { value: unknown }) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <p className="mt-1 break-words text-muted-foreground">Empty</p>;
    }
    return (
      <ul className="mt-1 flex flex-col gap-0.5">
        {entries.map(([key, item]) => (
          <li key={key} className="break-words">
            <span className="font-medium text-muted-foreground">{key}:</span>{" "}
            {formatConflictValue(item)}
          </li>
        ))}
      </ul>
    );
  }
  return <p className="mt-1 break-words">{formatConflictValue(value)}</p>;
}

function ViewAllDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">{children}</div>
        {footer ? <DialogFooter className="flex-wrap">{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

function WaitingBookRow({
  book,
  busy,
  onLocate,
  onForget,
}: {
  book: WaitingBook;
  busy: boolean;
  onLocate: (bookUid: string) => void;
  onForget: (bookUid: string) => void;
}) {
  return (
    <li
      data-testid={`waiting-book-${book.bookUid}`}
      className="flex flex-wrap items-start justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{book.title ?? "Unknown book"}</p>
        {book.author ? (
          <p className="truncate text-xs text-muted-foreground">{book.author}</p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {book.progressPercent === null ? "No progress" : `${Math.round(book.progressPercent)}%`}
          {" · "}
          {book.annotationCount} {book.annotationCount === 1 ? "annotation" : "annotations"}
        </p>
        {book.sampleAnnotation ? (
          <p className="mt-1 text-xs text-muted-foreground">Sample: {book.sampleAnnotation}</p>
        ) : null}
        <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{book.bookUid}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid={`locate-waiting-${book.bookUid}`}
          onClick={() => onLocate(book.bookUid)}
          disabled={busy}
        >
          Locate file
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid={`forget-waiting-${book.bookUid}`}
          onClick={() => onForget(book.bookUid)}
          disabled={busy}
        >
          Forget on this device
        </Button>
      </div>
    </li>
  );
}

export function WaitingBooksSection({
  books,
  total,
  busy,
  onLocate,
  onForget,
  onForgetAll,
}: {
  books: WaitingBook[];
  total: number;
  busy: boolean;
  onLocate: (bookUid: string) => void;
  onForget: (bookUid: string) => void;
  onForgetAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmForgetAll, setConfirmForgetAll] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return books;
    return books.filter((book) =>
      [book.title, book.author, book.sampleAnnotation, book.bookUid].some((value) =>
        value?.toLowerCase().includes(needle),
      ),
    );
  }, [books, query]);
  const summary = filtered.slice(0, SUMMARY_LIMIT);
  const truncated = total > books.length;

  return (
    <section data-testid="waiting-books" className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-medium">Waiting for books</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Shared reading state for books whose file is not in this library. Locate file attaches
            the book when you pick the exact bytes. Forget on this device hides it here; the synced
            copy stays in the folder and on other devices.
          </p>
        </div>
        {total > 0 ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="waiting-books-forget-all"
            onClick={() => setConfirmForgetAll(true)}
            disabled={busy}
          >
            Forget all on this device
          </Button>
        ) : null}
      </div>

      {total === 0 ? (
        <p data-testid="waiting-books-empty" className="mt-3 text-sm text-muted-foreground">
          No books are waiting for a file.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              data-testid="waiting-books-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title or book uid"
              className="h-9 max-w-sm"
            />
            {filtered.length > SUMMARY_LIMIT ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="waiting-books-view-all"
                onClick={() => setOpen(true)}
              >
                View all {filtered.length}
              </Button>
            ) : null}
            {truncated ? (
              <p className="text-xs text-muted-foreground">
                Showing first {books.length} of {total}.
              </p>
            ) : null}
          </div>
          <ul className="mt-3 flex flex-col gap-3">
            {summary.map((book) => (
              <WaitingBookRow
                key={book.bookUid}
                book={book}
                busy={busy}
                onLocate={onLocate}
                onForget={onForget}
              />
            ))}
          </ul>
          {filtered.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No waiting books match.</p>
          ) : null}
        </>
      )}

      <ViewAllDialog
        open={open}
        onOpenChange={setOpen}
        title="Waiting for books"
        description="Shared state for books whose file is not in this library. The synced copy is not deleted."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              variant="outline"
              data-testid="waiting-books-forget-all-dialog"
              onClick={() => {
                setOpen(false);
                setConfirmForgetAll(true);
              }}
              disabled={busy}
            >
              Forget all on this device
            </Button>
          </>
        }
      >
        <ul className="flex flex-col gap-3">
          {filtered.map((book) => (
            <WaitingBookRow
              key={book.bookUid}
              book={book}
              busy={busy}
              onLocate={onLocate}
              onForget={onForget}
            />
          ))}
        </ul>
      </ViewAllDialog>

      <Dialog open={confirmForgetAll} onOpenChange={setConfirmForgetAll}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Forget all waiting books on this device?</DialogTitle>
            <DialogDescription>
              This hides all {total} waiting {total === 1 ? "book" : "books"} here and drops the
              count. The synced copies stay in the folder, so importing the exact bytes can still
              attach them later. Other devices are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmForgetAll(false)}>
              Cancel
            </Button>
            <Button
              data-testid="waiting-books-forget-all-confirm"
              onClick={() => {
                setConfirmForgetAll(false);
                onForgetAll();
              }}
              disabled={busy}
            >
              Forget all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

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
  return action === "copy_details" || action === "dismiss";
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
    ) : issue.action === "open_folder" ? (
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
    ) : issue.action === "copy_details" ? (
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
          {issue.fileName ? (
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {issue.fileName}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">{formatSyncTime(issue.updatedAt)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {primary}
          {issue.action !== "copy_details" ? (
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
          {issue.action === "copy_details" ? (
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
          {total === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No sync issues.</p>
          ) : null}
        </div>
        {total > 0 && hasInformational ? (
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

      {total > 0 ? (
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

function blockedReasonFor(conflict: SyncConflict): string {
  return conflict.applyLoserBlockedReason ?? "The other value cannot be applied.";
}

function ConflictRow({
  conflict,
  deviceId,
  busy,
  idPrefix,
  onResolve,
  onLater,
}: {
  conflict: SyncConflict;
  deviceId: string | null;
  busy: boolean;
  idPrefix: string;
  onResolve: (id: number, resolution: SyncConflictResolution) => void;
  onLater: (id: number) => void;
}) {
  const choices = conflictChoices(conflict, deviceId);
  const isDelete = conflict.field === "__deleted__";
  const isRestore = conflict.field === "__restore__";
  const isTombstone = isDelete || isRestore;
  const fieldLabel = conflict.fieldLabel ?? conflict.field.replaceAll("_", " ");
  const editFieldCount = isTombstone ? objectFieldCount(conflict.loser) : null;
  const editLabel = isRestore ? "Restored" : "Edited";
  const blocked = !conflict.canApplyLoser;
  const blockedId = `sync-conflict-${idPrefix}-${conflict.id}-blocked`;

  return (
    <li data-testid={`sync-conflict-${conflict.id}`} className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{fieldLabel}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {conflict.kind.replaceAll("_", " ")}
          </p>
        </div>
        <ConflictActions
          conflict={conflict}
          choices={choices}
          blocked={blocked}
          busy={busy}
          blockedId={blockedId}
          onResolve={onResolve}
          onLater={onLater}
        />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <ConflictKeptPanel conflict={conflict} deviceId={deviceId} />
        <ConflictDiscardedPanel
          conflict={conflict}
          deviceId={deviceId}
          isTombstone={isTombstone}
          editLabel={editLabel}
          editFieldCount={editFieldCount}
        />
      </div>

      {blocked ? (
        <p
          id={blockedId}
          data-testid={`sync-conflict-${conflict.id}-blocked`}
          className="mt-2 text-xs text-muted-foreground"
        >
          {blockedReasonFor(conflict)}
        </p>
      ) : null}
    </li>
  );
}

function ConflictActions({
  conflict,
  choices,
  blocked,
  busy,
  blockedId,
  onResolve,
  onLater,
}: {
  conflict: SyncConflict;
  choices: ConflictChoice;
  blocked: boolean;
  busy: boolean;
  blockedId: string;
  onResolve: (id: number, resolution: SyncConflictResolution) => void;
  onLater: (id: number) => void;
}) {
  const thisDisabled = busy || (blocked && choices.thisDevice === "apply_loser");
  const otherDisabled = busy || (blocked && choices.other === "apply_loser");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        data-testid={`sync-conflict-${conflict.id}-this-device`}
        onClick={() => onResolve(conflict.id, choices.thisDevice)}
        disabled={thisDisabled}
        aria-describedby={blocked && choices.thisDevice === "apply_loser" ? blockedId : undefined}
      >
        {choices.thisLabel}
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-testid={`sync-conflict-${conflict.id}-other`}
        onClick={() => onResolve(conflict.id, choices.other)}
        disabled={otherDisabled}
        title={otherDisabled && blocked ? blockedReasonFor(conflict) : undefined}
        aria-describedby={blocked && choices.other === "apply_loser" ? blockedId : undefined}
      >
        {choices.otherLabel}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid={`sync-conflict-${conflict.id}-later`}
        onClick={() => onLater(conflict.id)}
        disabled={busy}
      >
        Decide later
      </Button>
    </div>
  );
}

function ConflictKeptPanel({
  conflict,
  deviceId,
}: {
  conflict: SyncConflict;
  deviceId: string | null;
}) {
  return (
    <div
      data-testid={`sync-conflict-${conflict.id}-kept`}
      title={fullValue(conflict.winner)}
      className="rounded-md bg-muted/40 p-2"
    >
      <p className="text-xs font-medium text-muted-foreground">Currently kept</p>
      {conflict.winner === "deleted" ? (
        <p className="mt-1 break-words">Deleted</p>
      ) : (
        <ConflictValue value={conflict.winner} />
      )}
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {deviceLabel(conflict.winnerDeviceName, conflict.winnerDeviceId, deviceId)} ·{" "}
        {formatSyncWall(conflict.winnerWall)}
      </p>
    </div>
  );
}

function ConflictDiscardedPanel({
  conflict,
  deviceId,
  isTombstone,
  editLabel,
  editFieldCount,
}: {
  conflict: SyncConflict;
  deviceId: string | null;
  isTombstone: boolean;
  editLabel: string;
  editFieldCount: number | null;
}) {
  return (
    <div
      data-testid={`sync-conflict-${conflict.id}-discarded`}
      title={fullValue(conflict.loser)}
      className="rounded-md border p-2"
    >
      <p className="text-xs font-medium text-muted-foreground">Discarded</p>
      {isTombstone ? (
        <p className="mt-1 text-xs font-medium text-muted-foreground">
          {editLabel}
          {editFieldCount === null
            ? ""
            : ` · ${editFieldCount} ${editFieldCount === 1 ? "field" : "fields"}`}
        </p>
      ) : null}
      <ConflictValue value={conflict.loser} />
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {deviceLabel(conflict.loserDeviceName, conflict.loserDeviceId, deviceId)} ·{" "}
        {formatSyncWall(conflict.loserWall)}
      </p>
    </div>
  );
}

function ConflictGroupView({
  group,
  deviceId,
  busy,
  idPrefix,
  onResolve,
  onLater,
}: {
  group: ConflictGroup;
  deviceId: string | null;
  busy: boolean;
  idPrefix: string;
  onResolve: (id: number, resolution: SyncConflictResolution) => void;
  onLater: (id: number) => void;
}) {
  return (
    <div data-testid={`sync-conflict-group-${group.key}`}>
      <h4 className="text-sm font-medium">{group.title}</h4>
      {group.author ? <p className="text-xs text-muted-foreground">{group.author}</p> : null}
      <ul className="mt-2 flex flex-col gap-2">
        {group.rows.map((conflict) => (
          <ConflictRow
            key={conflict.id}
            conflict={conflict}
            deviceId={deviceId}
            busy={busy}
            idPrefix={idPrefix}
            onResolve={onResolve}
            onLater={onLater}
          />
        ))}
      </ul>
    </div>
  );
}

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
