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
import type { SyncIssue, SyncTrashEntry, WaitingBook } from "@/lib/bridge";
import { formatSyncTime } from "./syncFormat";

const SUMMARY_LIMIT = 5;

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
  onForget,
}: {
  book: WaitingBook;
  busy: boolean;
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
      <Button
        size="sm"
        variant="outline"
        data-testid={`forget-waiting-${book.bookUid}`}
        onClick={() => onForget(book.bookUid)}
        disabled={busy}
      >
        Forget on this device
      </Button>
    </li>
  );
}

export function WaitingBooksSection({
  books,
  total,
  busy,
  onForget,
  onForgetAll,
}: {
  books: WaitingBook[];
  total: number;
  busy: boolean;
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
            Shared reading state for books whose file is not in this library. Import the exact file
            to attach it. Forget on this device hides it here; the synced copy stays in the folder
            and on other devices.
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
              <WaitingBookRow key={book.bookUid} book={book} busy={busy} onForget={onForget} />
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
            <WaitingBookRow key={book.bookUid} book={book} busy={busy} onForget={onForget} />
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

function IssueRow({ issue, onDismiss }: { issue: SyncIssue; onDismiss: (id: number) => void }) {
  return (
    <li className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{issue.kind.replaceAll("_", " ")}</p>
          <p className="mt-1 break-words text-muted-foreground">{issue.detail}</p>
          {issue.fileName ? (
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {issue.fileName}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">{formatSyncTime(issue.updatedAt)}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onDismiss(issue.id)}
          data-testid={`sync-dismiss-${issue.id}`}
        >
          Dismiss
        </Button>
      </div>
    </li>
  );
}

export function SyncIssuesSection({
  issues,
  total,
  busy,
  onDismiss,
  onDismissAll,
}: {
  issues: SyncIssue[];
  total: number;
  busy: boolean;
  onDismiss: (id: number) => void;
  onDismissAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDismissAll, setConfirmDismissAll] = useState(false);
  const summary = issues.slice(0, SUMMARY_LIMIT);
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
        {total > 0 ? (
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
              <IssueRow key={issue.id} issue={issue} onDismiss={onDismiss} />
            ))}
          </ul>
        </>
      ) : null}

      <ViewAllDialog
        open={open}
        onOpenChange={setOpen}
        title="Sync issues"
        description="Grouped by kind. Dismissing an issue only hides the report; the underlying state is unchanged."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              variant="outline"
              data-testid="sync-issues-dismiss-all-dialog"
              onClick={() => {
                setOpen(false);
                setConfirmDismissAll(true);
              }}
              disabled={busy}
            >
              Dismiss all
            </Button>
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
                  <IssueRow key={issue.id} issue={issue} onDismiss={onDismiss} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </ViewAllDialog>

      <Dialog open={confirmDismissAll} onOpenChange={setConfirmDismissAll}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Dismiss all sync issues?</DialogTitle>
            <DialogDescription>
              This hides all {total} open {total === 1 ? "issue" : "issues"}. The underlying sync
              state and the issues in the folder are unchanged.
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
