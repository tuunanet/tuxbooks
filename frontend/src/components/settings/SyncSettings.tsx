import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Unplug } from "lucide-react";
import {
  connectSync,
  disconnectSync,
  dismissSyncIssue,
  getSyncStatus,
  listSyncIssues,
  listSyncTrash,
  onSyncStatus,
  pickSyncFolder,
  restoreSyncTrash,
  setSyncDeviceName,
  syncNow,
  type SyncIssue,
  type SyncMismatch,
  type SyncState,
  type SyncStatus,
  type SyncTrashEntry,
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

function formatTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState<MismatchPrompt | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [editingDevice, setEditingDevice] = useState(false);

  const applyStatus = useCallback((next: SyncStatus) => {
    setStatus(next);
    setDeviceName(next.deviceName ?? "");
  }, []);

  const loadLists = useCallback(async () => {
    try {
      const [nextIssues, nextTrash] = await Promise.all([listSyncIssues(), listSyncTrash()]);
      setIssues(nextIssues);
      setTrash(nextTrash);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await getSyncStatus();
        if (!active) return;
        applyStatus(next);
        if (next.enabled) {
          const [nextIssues, nextTrash] = await Promise.all([listSyncIssues(), listSyncTrash()]);
          if (!active) return;
          setIssues(nextIssues);
          setTrash(nextTrash);
        } else {
          setIssues([]);
          setTrash([]);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [applyStatus]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onSyncStatus((next) => {
      if (!cancelled) applyStatus(next);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyStatus]);

  const connect = useCallback(async () => {
    setError(null);
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

  const now = useCallback(async () => {
    setError(null);
    try {
      applyStatus(await syncNow());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [applyStatus]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      applyStatus(await disconnectSync());
      setConfirmDisconnect(false);
      setIssues([]);
      setTrash([]);
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
        await loadLists();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [loadLists],
  );

  const restore = useCallback(
    async (id: number) => {
      try {
        await restoreSyncTrash(id);
        await loadLists();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [loadLists],
  );

  const enabled = status?.enabled ?? false;

  return (
    <div data-testid="sync-settings" className="mt-6 flex flex-col gap-6">
      <section className="rounded-lg border p-4">
        <h3 className="text-base font-medium">Cloud folder</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          TuxBooks syncs through a folder your cloud client already keeps in sync. It never talks to
          Google Drive or Dropbox directly, so any folder works: Dropbox, Google Drive, Nextcloud,
          or Syncthing.
        </p>

        {status === null ? (
          <p className="mt-4 text-sm text-muted-foreground">Reading sync status…</p>
        ) : !enabled ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Choose the folder. TuxBooks creates a <span className="font-mono">TuxBooks</span>{" "}
              subfolder for its own files and leaves everything else alone.
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
      </section>

      {enabled ? (
        <section className="rounded-lg border p-4">
          <h3 className="text-base font-medium">Sync issues</h3>
          {issues.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No sync issues.</p>
          ) : (
            <ul data-testid="sync-issues" className="mt-3 flex flex-col gap-3">
              {issues.map((issue) => (
                <li key={issue.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{issue.kind.replaceAll("_", " ")}</p>
                      <p className="mt-1 break-words text-muted-foreground">{issue.detail}</p>
                      {issue.fileName ? (
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          {issue.fileName}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatTime(issue.updatedAt)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void dismiss(issue.id)}
                      data-testid={`sync-dismiss-${issue.id}`}
                    >
                      Dismiss
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {enabled ? (
        <section className="rounded-lg border p-4">
          <h3 className="text-base font-medium">Recently deleted</h3>
          {trash.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Deleted annotations and collections stay restorable for 30 days.
            </p>
          ) : (
            <ul data-testid="sync-trash" className="mt-3 flex flex-col gap-3">
              {trash.map((entry) => (
                <li key={entry.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{entry.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {entry.kind} · deleted {formatTime(entry.deletedAt)} · restorable until{" "}
                        {formatTime(entry.expiresAt)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void restore(entry.id)}
                      data-testid={`sync-restore-${entry.id}`}
                    >
                      Restore
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <Dialog open={mismatch !== null} onOpenChange={(open) => !open && setMismatch(null)}>
        <DialogContent data-testid="sync-mismatch">
          <DialogHeader>
            <DialogTitle>This folder belongs to another library</DialogTitle>
            <DialogDescription>
              The folder was created by a different TuxBooks library. Joining it will merge this
              machine&apos;s reading state into that library and forget this machine&apos;s previous
              sync history. The local books and files stay where they are.
            </DialogDescription>
          </DialogHeader>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {mismatch?.mismatch.remoteLibraryId}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMismatch(null)}>
              Cancel
            </Button>
            <Button
              data-testid="sync-confirm-join"
              onClick={() => void confirmJoin()}
              disabled={busy}
            >
              Join this library
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
    <div className={cn("rounded-md border p-2", value > 0 ? "bg-muted/40" : undefined)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-medium tabular-nums">{value}</p>
    </div>
  );
}
