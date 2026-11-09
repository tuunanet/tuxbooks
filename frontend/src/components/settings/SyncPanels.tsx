/**
 * Presentational sections of Settings > Sync: the folder card, the connected
 * status panel, and the issue/trash lists behind it. State and the
 * actions they fire live in `SyncSettings`; this file only renders.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PlugZap, RefreshCw, Unplug } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type SyncIssue,
  type SyncState,
  type SyncStatus,
  type SyncTrashEntry,
  type WaitingBook,
} from "@/lib/bridge";
import { SyncIssuesSection } from "./SyncIssues";
import { SyncTrashSection } from "./SyncTrash";
import { WaitingBooksSection } from "./SyncWaiting";
import { formatSyncTime as formatTime } from "./syncFormat";

const STATUS_LABEL: Record<SyncState, string> = {
  disabled: "Off",
  idle: "Up to date",
  syncing: "Syncing",
  error: "Needs attention",
};

function statusVariant(state: SyncState): "default" | "secondary" | "destructive" | "outline" {
  if (state === "error") return "destructive";
  if (state === "syncing") return "secondary";
  if (state === "disabled") return "outline";
  return "default";
}

/**
 * The status payload carries `lastError` as a plain string with no structured
 * kind. The sidecar stores the pass failure's Display form, so error wrappers
 * prefix this message ("invalid input: " comes from AppError::InvalidInput);
 * the suffix is the stable part, and endsWith is the contract for the one
 * failure that can be repaired in place: the folder now belongs to another
 * library, and reconnecting confirms or replaces it. Pinned from the sidecar
 * by a_pass_rejects_a_folder_that_belongs_to_another_library.
 */
const LIBRARY_MISMATCH_ERROR = "sync folder belongs to a different library; reconnect to confirm";

type SyncSectionsProps = {
  status: SyncStatus;
  issues: SyncIssue[];
  trash: SyncTrashEntry[];
  busy: boolean;
  onIssueAction: (issue: SyncIssue) => void;
  onCopyIssueDetails: (issue: SyncIssue) => void;
  onDismissIssue: (id: number) => void;
  onDismissAllIssues: () => void;
  onRestoreTrash: (id: number) => void;
};

export function SyncSections({
  status,
  issues,
  trash,
  busy,
  onIssueAction,
  onCopyIssueDetails,
  onDismissIssue,
  onDismissAllIssues,
  onRestoreTrash,
}: SyncSectionsProps) {
  return (
    <>
      <SyncIssuesSection
        issues={issues}
        total={status.issues}
        busy={busy}
        onAction={onIssueAction}
        onCopyDetails={onCopyIssueDetails}
        onDismiss={onDismissIssue}
        onDismissAll={onDismissAllIssues}
      />
      <SyncTrashSection
        entries={trash}
        total={status.trash}
        busy={busy}
        onRestore={onRestoreTrash}
      />
    </>
  );
}

type SyncFolderSectionProps = {
  status: SyncStatus | null;
  enabled: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  waitingBooks: WaitingBook[];
  onConnect: () => void;
  onReconnect: () => void;
  onEditDevice: () => void;
  onSyncNow: () => void;
  onDisconnect: () => void;
  onAutoRetry: (enabled: boolean) => void;
  onLocate: (bookUid: string) => void;
  onForget: (bookUid: string) => void;
  onForgetAll: () => void;
};

export function SyncFolderSection({
  status,
  enabled,
  busy,
  error,
  notice,
  waitingBooks,
  onConnect,
  onReconnect,
  onEditDevice,
  onSyncNow,
  onDisconnect,
  onAutoRetry,
  onLocate,
  onForget,
  onForgetAll,
}: SyncFolderSectionProps) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-base font-medium">Sync folder</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        TuxBooks keeps a small set of reading state in a folder every machine can reach. A local
        directory, a network path, and a folder a cloud client keeps in sync all work the same way.
      </p>

      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-md border p-3">
          <p className="font-medium">Syncs between machines</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
            <li>Reading progress and last-opened time</li>
            <li>Bookmarks, highlights, and notes</li>
            <li>Collections and which books are in them</li>
            <li>Library metadata edits (values the book file cannot store)</li>
            <li>Custom covers</li>
          </ul>
        </div>
        <div className="rounded-md border p-3">
          <p className="font-medium">Not carried by this sync</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
            <li>Book files themselves</li>
            <li>The library catalog and watched folders</li>
            <li>Reader appearance and theme</li>
          </ul>
        </div>
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        Saving metadata into a book file rewrites that file. Those edits, and the one-time{" "}
        <span className="font-mono">.bak</span> backup next to it, reach another machine only when
        the book folder syncs as well. This folder holds library-side state only.
      </p>

      <p className="mt-3 text-sm text-muted-foreground">
        If your books already live in a folder you sync, that sync keeps carrying the files.
        TuxBooks only writes its own state under a <span className="font-mono">TuxBooks</span>{" "}
        subfolder and leaves everything else alone.
      </p>

      {status === null ? (
        <p className="mt-4 text-sm text-muted-foreground">Reading sync status…</p>
      ) : !enabled ? (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Choose any folder every machine can reach. Local directories, network paths, and folders
            a cloud client syncs all work.
          </p>
          <div>
            <Button data-testid="sync-connect" onClick={onConnect} disabled={busy}>
              Choose sync folder
            </Button>
          </div>
        </div>
      ) : (
        <ConnectedSyncPanel
          status={status}
          busy={busy}
          waitingBooks={waitingBooks}
          onReconnect={onReconnect}
          onEditDevice={onEditDevice}
          onSyncNow={onSyncNow}
          onDisconnect={onDisconnect}
          onAutoRetry={onAutoRetry}
          onLocate={onLocate}
          onForget={onForget}
          onForgetAll={onForgetAll}
        />
      )}

      {error ? (
        <p
          data-testid="sync-action-error"
          role="alert"
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          data-testid="sync-notice"
          className="mt-4 break-all rounded-md border p-3 text-sm text-muted-foreground"
        >
          {notice}
        </p>
      ) : null}
    </section>
  );
}

type ConnectedSyncPanelProps = {
  status: SyncStatus;
  busy: boolean;
  waitingBooks: WaitingBook[];
  onReconnect: () => void;
  onEditDevice: () => void;
  onSyncNow: () => void;
  onDisconnect: () => void;
  onAutoRetry: (enabled: boolean) => void;
  onLocate: (bookUid: string) => void;
  onForget: (bookUid: string) => void;
  onForgetAll: () => void;
};

function ConnectedSyncPanel({
  status,
  busy,
  waitingBooks,
  onReconnect,
  onEditDevice,
  onSyncNow,
  onDisconnect,
  onAutoRetry,
  onLocate,
  onForget,
  onForgetAll,
}: ConnectedSyncPanelProps) {
  const reconnectNeeded = status.lastError?.endsWith(LIBRARY_MISMATCH_ERROR) ?? false;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Status</span>
        <Badge data-testid="sync-status" variant={statusVariant(status.state)} aria-live="polite">
          {STATUS_LABEL[status.state]}
        </Badge>
        {status.state === "syncing" ? (
          <RefreshCw className="size-4 animate-spin text-muted-foreground" aria-hidden />
        ) : null}
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">Folder</dt>
        <dd data-testid="sync-folder" className="break-all font-mono text-xs">
          {status.folder ?? "Not connected"}
        </dd>
        <dt className="text-muted-foreground">Device</dt>
        <dd className="flex items-center gap-2">
          <span data-testid="sync-device-name">{status.deviceName ?? "This device"}</span>
          <Button size="sm" variant="ghost" onClick={onEditDevice}>
            Edit
          </Button>
        </dd>
        <dt className="text-muted-foreground">Last sync</dt>
        <dd data-testid="sync-last-sync">{formatTime(status.lastSyncAt)}</dd>
      </dl>

      <label className="flex items-start gap-2">
        <Checkbox
          data-testid="sync-auto-retry"
          checked={status.autoRetry}
          disabled={busy}
          onCheckedChange={(checked) => onAutoRetry(checked === true)}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">Automatic retry</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Retry fixable failures on a schedule, with a per-issue attempt cap. A row that keeps
            failing stays listed and asks for attention only when the attempts run out.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Stat label="Pending" value={status.pendingLocal} />
        <Stat label="Waiting for books" value={status.waitingBooks} />
        <Stat label="Issues" value={status.issues} />
        <Stat label="Recently deleted" value={status.trash} />
      </div>

      {status.lastError ? (
        <p
          data-testid="sync-error"
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {status.lastError}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {reconnectNeeded ? (
          <Button
            data-testid="sync-reconnect"
            onClick={onReconnect}
            disabled={busy || status.state === "syncing"}
          >
            <PlugZap className="size-4" aria-hidden />
            Reconnect
          </Button>
        ) : null}
        <Button data-testid="sync-now" onClick={onSyncNow} disabled={status.state === "syncing"}>
          Sync now
        </Button>
        <Button data-testid="sync-disconnect" variant="outline" onClick={onDisconnect}>
          <Unplug className="size-4" aria-hidden />
          Disconnect
        </Button>
      </div>

      <WaitingBooksSection
        books={waitingBooks}
        total={status.waitingBooks}
        busy={busy}
        onLocate={onLocate}
        onForget={onForget}
        onForgetAll={onForgetAll}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div
      className={cn(
        "flex h-full flex-col justify-between gap-1 rounded-md border p-2",
        value > 0 ? "bg-muted/40" : undefined,
      )}
    >
      <p className="text-xs leading-tight text-muted-foreground">{label}</p>
      <p className="text-lg font-medium leading-none tabular-nums">{value}</p>
    </div>
  );
}
