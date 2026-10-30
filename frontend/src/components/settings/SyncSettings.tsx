import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Unplug } from "lucide-react";
import {
  attachWaitingBook,
  connectSync,
  disconnectSync,
  dismissAllSyncIssues,
  dismissSyncIssue,
  forgetAllWaitingBooks,
  forgetWaitingBook,
  getSyncStatus,
  listSyncConflicts,
  listSyncIssues,
  listSyncTrash,
  listWaitingBooks,
  openSyncFolder,
  onSyncStatus,
  pickBookFile,
  pickSyncFolder,
  resolveSyncConflict,
  restoreSyncTrash,
  retrySyncIssue,
  setSyncDeviceName,
  syncNow,
  type SyncConflict,
  type SyncConflictResolution,
  type SyncIssue,
  type SyncMismatch,
  type SyncState,
  type SyncStatus,
  type SyncTrashEntry,
  type WaitingBook,
} from "@/lib/bridge";
import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  SyncConflictsSection,
  SyncIssuesSection,
  SyncTrashSection,
  WaitingBooksSection,
  formatIssueDetails,
} from "./SyncLists";
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

type MismatchPrompt = {
  path: string;
  mismatch: SyncMismatch;
};

/**
 * Settings > Sync. TuxBooks writes plain, schema-versioned JSON into a folder
 * that a cloud client already syncs; it never calls Google Drive or Dropbox
 * APIs. See docs/SYNC.md.
 */
export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [issues, setIssues] = useState<SyncIssue[]>([]);
  const [trash, setTrash] = useState<SyncTrashEntry[]>([]);
  const [waitingBooks, setWaitingBooks] = useState<WaitingBook[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState<MismatchPrompt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [editingDevice, setEditingDevice] = useState(false);

  const applyStatus = useCallback((next: SyncStatus) => {
    setStatus(next);
    setDeviceName(next.deviceName ?? "");
  }, []);

  const loadLists = useCallback(async () => {
    try {
      const [nextIssues, nextTrash, nextWaiting, nextConflicts] = await Promise.all([
        listSyncIssues(),
        listSyncTrash(),
        listWaitingBooks(),
        listSyncConflicts(),
      ]);
      setIssues(nextIssues);
      setTrash(nextTrash);
      setWaitingBooks(nextWaiting);
      setConflicts(nextConflicts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const clearLists = useCallback(() => {
    setIssues([]);
    setTrash([]);
    setWaitingBooks([]);
    setConflicts([]);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const next = await getSyncStatus();
        if (!active) return;
        applyStatus(next);
        if (next.enabled) await loadLists();
        else clearLists();
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [applyStatus, loadLists, clearLists]);

  useEffect(() => {
    let active = true;
    const timer = setInterval(async () => {
      try {
        const next = await getSyncStatus();
        if (active) applyStatus(next);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [applyStatus]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onSyncStatus((next) => {
      if (cancelled) return;
      applyStatus(next);
      if (next.enabled) void loadLists();
      else clearLists();
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyStatus, loadLists, clearLists]);

  const connect = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const folder = await pickSyncFolder();
      if (!folder) return;
      const result = await connectSync(folder);
      if (result.mismatch) {
        setMismatch({ path: folder, mismatch: result.mismatch });
        return;
      }
      applyStatus(result.status);
      if (result.archivedLibraryPath) {
        setNotice(`The previous library was kept at ${result.archivedLibraryPath}.`);
      }
      await loadLists();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [applyStatus, loadLists]);

  const confirmJoin = useCallback(async () => {
    if (!mismatch) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await connectSync(mismatch.path, {
        confirmLibraryId: mismatch.mismatch.remoteLibraryId,
      });
      applyStatus(result.status);
      setMismatch(null);
      await loadLists();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [applyStatus, loadLists, mismatch]);

  const startNewLibrary = useCallback(async () => {
    if (!mismatch) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await connectSync(mismatch.path, { startNew: true });
      if (result.mismatch) {
        setMismatch({ path: mismatch.path, mismatch: result.mismatch });
        return;
      }
      applyStatus(result.status);
      setMismatch(null);
      if (result.archivedLibraryPath) {
        setNotice(`The previous library was kept at ${result.archivedLibraryPath}.`);
      }
      await loadLists();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [applyStatus, loadLists, mismatch]);

  const now = useCallback(async () => {
    setError(null);
    try {
      applyStatus(await syncNow());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [applyStatus]);

  const forgetWaiting = useCallback(
    async (bookUid: string) => {
      setBusy(true);
      setError(null);
      try {
        await forgetWaitingBook(bookUid);
        applyStatus(await getSyncStatus());
        await loadLists();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applyStatus, loadLists],
  );

  /**
   * Locate the file behind a waiting book. The sidecar hashes the picked bytes
   * and attaches only when they carry the waiting uid's alias, so a different
   * edition is refused with a readable message and the row stays.
   */
  const locateWaiting = useCallback(
    async (bookUid: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const path = await pickBookFile();
        if (!path) return;
        await attachWaitingBook(bookUid, path);
        applyStatus(await getSyncStatus());
        await loadLists();
        setNotice("Attached the waiting book.");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applyStatus, loadLists],
  );

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      applyStatus(await disconnectSync());
      setConfirmDisconnect(false);
      setIssues([]);
      setTrash([]);
      setWaitingBooks([]);
      setConflicts([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [applyStatus]);

  const saveDeviceName = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      applyStatus(await setSyncDeviceName(deviceName));
      setEditingDevice(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [applyStatus, deviceName]);

  const dismiss = useCallback(
    async (id: number) => {
      try {
        await dismissSyncIssue(id);
        applyStatus(await getSyncStatus());
        await loadLists();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [applyStatus, loadLists],
  );

  /**
   * Run the primary action the sidecar mapped for a row. Retry and dismiss
   * reload status and lists for immediate feedback; the sync event reloads
   * them again, which is cheap and keeps every list consistent.
   */
  const issueAction = useCallback(
    async (issue: SyncIssue) => {
      setError(null);
      setNotice(null);
      try {
        if (issue.action === "retry") {
          setBusy(true);
          await retrySyncIssue(issue.id);
          applyStatus(await getSyncStatus());
          await loadLists();
        } else if (issue.action === "open_folder") {
          await openSyncFolder();
        } else if (issue.action === "copy_details") {
          await navigator.clipboard.writeText(formatIssueDetails(issue));
          setNotice("Copied issue details.");
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applyStatus, loadLists],
  );

  /** Secondary action on any row: copy the readable block to the clipboard. */
  const copyIssueDetails = useCallback(async (issue: SyncIssue) => {
    setError(null);
    setNotice(null);
    try {
      await navigator.clipboard.writeText(formatIssueDetails(issue));
      setNotice("Copied issue details.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const dismissAllIssues = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const count = await dismissAllSyncIssues();
      applyStatus(await getSyncStatus());
      await loadLists();
      setNotice(count > 0 ? `Dismissed ${count} sync ${count === 1 ? "issue" : "issues"}.` : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [applyStatus, loadLists]);

  const restore = useCallback(
    async (id: number) => {
      try {
        await restoreSyncTrash(id);
        applyStatus(await getSyncStatus());
        await loadLists();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [applyStatus, loadLists],
  );

  const resolveConflict = useCallback(
    async (id: number, resolution: SyncConflictResolution) => {
      setBusy(true);
      setError(null);
      try {
        await resolveSyncConflict(id, resolution);
        applyStatus(await getSyncStatus());
        await loadLists();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applyStatus, loadLists],
  );

  const keepAllWinners = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      let firstError: unknown = null;
      let kept = 0;
      try {
        for (const id of ids) {
          try {
            if (await resolveSyncConflict(id, "keep_winner")) kept += 1;
          } catch (cause) {
            if (firstError === null) firstError = cause;
          }
        }
      } catch (cause) {
        if (firstError === null) firstError = cause;
      } finally {
        try {
          applyStatus(await getSyncStatus());
          await loadLists();
        } catch (cause) {
          if (firstError === null) firstError = cause;
        }
        if (firstError !== null) {
          setError(firstError instanceof Error ? firstError.message : String(firstError));
        } else if (kept === 0) {
          setNotice("Those conflicts were already resolved.");
        } else {
          setNotice(
            `Kept the current winner for ${kept} ${kept === 1 ? "conflict" : "conflicts"}.`,
          );
        }
        setBusy(false);
      }
    },
    [applyStatus, loadLists],
  );

  const forgetAllWaiting = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const count = await forgetAllWaitingBooks();
      applyStatus(await getSyncStatus());
      await loadLists();
      setNotice(
        count > 0
          ? `Forgot ${count} waiting ${count === 1 ? "book" : "books"} on this device.`
          : null,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [applyStatus, loadLists]);

  const enabled = status?.enabled ?? false;

  return (
    <div data-testid="sync-settings" className="mt-6 flex flex-col gap-6">
      <section className="rounded-lg border p-4">
        <h3 className="text-base font-medium">Cloud folder</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          TuxBooks keeps a small set of reading state in a folder your cloud client already syncs.
          It never talks to Google Drive or Dropbox directly.
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
              <li>Book files (EPUB and PDF)</li>
              <li>The library catalog and watched folders</li>
              <li>Reader appearance and theme</li>
            </ul>
          </div>
        </div>

        <p className="mt-3 text-sm text-muted-foreground">
          Saving metadata into an EPUB or PDF rewrites the book file. Those edits, and the one-time{" "}
          <span className="font-mono">.bak</span> backup next to it, reach another machine only when
          your cloud client carries the book folder as well. This folder holds library-side state
          only.
        </p>

        <p className="mt-3 text-sm text-muted-foreground">
          If your books already live in a cloud folder, your client keeps syncing the files.
          TuxBooks only writes its own state under a <span className="font-mono">TuxBooks</span>{" "}
          subfolder and leaves everything else alone.
        </p>

        {status === null ? (
          <p className="mt-4 text-sm text-muted-foreground">Reading sync status…</p>
        ) : !enabled ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Choose the folder your client syncs. Dropbox, Google Drive, Nextcloud, Syncthing, and
              any other local folder work.
            </p>
            <div>
              <Button data-testid="sync-connect" onClick={() => void connect()} disabled={busy}>
                Choose sync folder
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Status</span>
              <Badge
                data-testid="sync-status"
                variant={statusVariant(status.state)}
                aria-live="polite"
              >
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
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDeviceName(status.deviceName ?? "");
                    setEditingDevice(true);
                  }}
                >
                  Edit
                </Button>
              </dd>
              <dt className="text-muted-foreground">Last sync</dt>
              <dd data-testid="sync-last-sync">{formatTime(status.lastSyncAt)}</dd>
            </dl>

            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              <Stat label="Pending" value={status.pendingLocal} />
              <Stat label="Waiting for books" value={status.waitingBooks} />
              <Stat label="Issues" value={status.issues} />
              <Stat label="Recently deleted" value={status.trash} />
              <Stat label="Conflicts" value={status.conflicts} />
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
              <Button
                data-testid="sync-now"
                onClick={() => void now()}
                disabled={status.state === "syncing"}
              >
                Sync now
              </Button>
              <Button
                data-testid="sync-disconnect"
                variant="outline"
                onClick={() => setConfirmDisconnect(true)}
              >
                <Unplug className="size-4" aria-hidden />
                Disconnect
              </Button>
            </div>

            <WaitingBooksSection
              books={waitingBooks}
              total={status.waitingBooks}
              busy={busy}
              onLocate={(bookUid) => void locateWaiting(bookUid)}
              onForget={(bookUid) => void forgetWaiting(bookUid)}
              onForgetAll={() => void forgetAllWaiting()}
            />
          </div>
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

      {enabled ? (
        <SyncIssuesSection
          issues={issues}
          total={status?.issues ?? 0}
          busy={busy}
          onAction={(issue) => void issueAction(issue)}
          onCopyDetails={(issue) => void copyIssueDetails(issue)}
          onDismiss={(id) => void dismiss(id)}
          onDismissAll={() => void dismissAllIssues()}
        />
      ) : null}

      {enabled ? (
        <SyncConflictsSection
          key={`${status?.libraryId ?? ""}:${status?.folder ?? ""}:${status?.deviceId ?? ""}`}
          conflicts={conflicts}
          total={status?.conflicts ?? 0}
          deviceId={status?.deviceId ?? null}
          busy={busy}
          onResolve={(id, resolution) => void resolveConflict(id, resolution)}
          onKeepAll={(ids) => void keepAllWinners(ids)}
        />
      ) : null}

      {enabled ? (
        <SyncTrashSection
          entries={trash}
          total={status?.trash ?? 0}
          busy={busy}
          onRestore={(id) => void restore(id)}
        />
      ) : null}

      <Dialog open={mismatch !== null} onOpenChange={(open) => !open && setMismatch(null)}>
        <DialogContent data-testid="sync-mismatch">
          <DialogHeader>
            <DialogTitle>This folder already has a TuxBooks library</DialogTitle>
            <DialogDescription>
              TuxBooks found an existing sync library here. Use it to merge this device&apos;s
              reading state into it, or start a new library here. Starting a new one keeps the old
              library in a backup folder beside it. Your books and files are not moved. Other
              devices using this folder will need to reconnect to the backup.
            </DialogDescription>
          </DialogHeader>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {mismatch?.mismatch.remoteLibraryId}
          </p>
          <DialogFooter className="flex-wrap">
            <Button variant="outline" onClick={() => setMismatch(null)}>
              Cancel
            </Button>
            <Button
              data-testid="sync-start-new"
              variant="outline"
              onClick={() => void startNewLibrary()}
              disabled={busy}
            >
              Start a new library here
            </Button>
            <Button
              data-testid="sync-confirm-join"
              onClick={() => void confirmJoin()}
              disabled={busy}
            >
              Use this library
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent data-testid="sync-disconnect-dialog">
          <DialogHeader>
            <DialogTitle>Disconnect this device?</DialogTitle>
            <DialogDescription>
              Syncing stops on this machine. The cloud folder is left untouched, so another machine
              can keep using it or you can reconnect later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDisconnect(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="sync-confirm-disconnect"
              onClick={() => void disconnect()}
              disabled={busy}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editingDevice} onOpenChange={setEditingDevice}>
        <DialogContent data-testid="sync-device-dialog">
          <DialogHeader>
            <DialogTitle>Device name</DialogTitle>
            <DialogDescription>
              Shown in this app so you can tell machines apart. It is not sent to the cloud
              provider.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sync-device-input">Name</Label>
            <Input
              id="sync-device-input"
              value={deviceName}
              maxLength={80}
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingDevice(false)}>
              Cancel
            </Button>
            <Button
              data-testid="sync-save-device"
              onClick={() => void saveDeviceName()}
              disabled={busy || deviceName.trim().length === 0}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
