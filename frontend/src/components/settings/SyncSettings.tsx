import { useCallback, useState } from "react";
import {
  attachWaitingBook,
  connectSync,
  copyText,
  disconnectSync,
  dismissAllSyncIssues,
  dismissSyncIssue,
  forgetAllWaitingBooks,
  forgetWaitingBook,
  getSyncStatus,
  listSyncIssues,
  listSyncTrash,
  listWaitingBooks,
  openSyncFolder,
  pickBookFile,
  pickSyncFolder,
  restoreSyncTrash,
  retrySyncIssue,
  setSyncAutoRetry,
  setSyncDeviceName,
  syncNow,
  type SyncIssue,
  type SyncStatus,
  type SyncTrashEntry,
  type WaitingBook,
} from "@/lib/bridge";
import { formatIssueDetails } from "./SyncIssues";
import { SyncFolderSection, SyncSections } from "./SyncPanels";
import { useSyncStatusRefresh } from "./useSyncStatusRefresh";
import {
  DeviceNameDialog,
  DisconnectDialog,
  SyncMismatchDialog,
  type MismatchPrompt,
} from "./SyncDialogs";

/**
 * Settings > Sync. TuxBooks writes plain, schema-versioned JSON into a folder
 * the user already syncs, whether it lives on a local disk, a network path, or
 * a cloud client's folder; it never calls a provider's API. See docs/SYNC.md.
 */
export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [issues, setIssues] = useState<SyncIssue[]>([]);
  const [trash, setTrash] = useState<SyncTrashEntry[]>([]);
  const [waitingBooks, setWaitingBooks] = useState<WaitingBook[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState<MismatchPrompt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  // Only whether the editor is open lives here. The dialog owns its draft, so
  // status refreshes (poll and sync events) cannot overwrite what is typed.
  const [editingDevice, setEditingDevice] = useState(false);

  const applyStatus = useCallback((next: SyncStatus) => {
    setStatus(next);
  }, []);

  const loadLists = useCallback(async () => {
    try {
      const [nextIssues, nextTrash, nextWaiting] = await Promise.all([
        listSyncIssues(),
        listSyncTrash(),
        listWaitingBooks(),
      ]);
      setIssues(nextIssues);
      setTrash(nextTrash);
      setWaitingBooks(nextWaiting);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const clearLists = useCallback(() => {
    setIssues([]);
    setTrash([]);
    setWaitingBooks([]);
  }, []);

  useSyncStatusRefresh({ applyStatus, loadLists, clearLists, setError });

  /**
   * Connect to a folder and land the answer: a mismatch opens the
   * confirmation dialog; otherwise the status lands, the archived-library
   * notice (connect's start-new path) may fire, and the lists reload. First
   * connect and reconnect differ only in where the folder comes from, so
   * both run through here.
   */
  const runConnect = useCallback(
    async (folder: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
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
    },
    [applyStatus, loadLists],
  );

  const connect = useCallback(async () => {
    setError(null);
    setNotice(null);
    // Busy before the picker opens, so the button cannot re-open it.
    setBusy(true);
    try {
      const folder = await pickSyncFolder();
      if (!folder) return;
      await runConnect(folder);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [runConnect]);

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

  /**
   * Offered on the library-mismatch error: re-run connect against the folder
   * the device is still pointed at. The sidecar answers with the mismatch
   * payload again, which opens the same confirmation dialog as the first
   * connect; confirming there resets the local sync state, merges into the
   * folder's library, clears the error, and runs a pass. Cancelling changes
   * nothing.
   */
  const reconnect = useCallback(async () => {
    if (!status?.folder) return;
    await runConnect(status.folder);
  }, [runConnect, status]);

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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [applyStatus]);

  const saveDeviceName = useCallback(
    async (name: string) => {
      setBusy(true);
      setError(null);
      try {
        applyStatus(await setSyncDeviceName(name));
        setEditingDevice(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applyStatus],
  );

  const setAutoRetry = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      setError(null);
      try {
        applyStatus(await setSyncAutoRetry(enabled));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applyStatus],
  );

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
          await copyText(formatIssueDetails(issue));
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
      await copyText(formatIssueDetails(issue));
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
      <SyncFolderSection
        status={status}
        enabled={enabled}
        busy={busy}
        error={error}
        notice={notice}
        waitingBooks={waitingBooks}
        onConnect={() => void connect()}
        onReconnect={() => void reconnect()}
        onEditDevice={() => setEditingDevice(true)}
        onSyncNow={() => void now()}
        onDisconnect={() => setConfirmDisconnect(true)}
        onAutoRetry={(next) => void setAutoRetry(next)}
        onLocate={(bookUid) => void locateWaiting(bookUid)}
        onForget={(bookUid) => void forgetWaiting(bookUid)}
        onForgetAll={() => void forgetAllWaiting()}
      />

      {status?.enabled ? (
        <SyncSections
          status={status}
          issues={issues}
          trash={trash}
          busy={busy}
          onIssueAction={(issue) => void issueAction(issue)}
          onCopyIssueDetails={(issue) => void copyIssueDetails(issue)}
          onDismissIssue={(id) => void dismiss(id)}
          onDismissAllIssues={() => void dismissAllIssues()}
          onRestoreTrash={(id) => void restore(id)}
        />
      ) : null}

      <SyncMismatchDialog
        mismatch={mismatch}
        busy={busy}
        onCancel={() => setMismatch(null)}
        onStartNew={() => void startNewLibrary()}
        onConfirmJoin={() => void confirmJoin()}
      />

      <DisconnectDialog
        open={confirmDisconnect}
        busy={busy}
        onOpenChange={setConfirmDisconnect}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
      />

      <DeviceNameDialog
        open={editingDevice}
        initialName={status?.deviceName ?? ""}
        busy={busy}
        onOpenChange={setEditingDevice}
        onCancel={() => setEditingDevice(false)}
        onSave={(name) => void saveDeviceName(name)}
      />
    </div>
  );
}
