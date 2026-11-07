import { useEffect } from "react";

import { getSyncStatus, onSyncStatus, type SyncStatus } from "@/lib/bridge";

/**
 * Keep the Settings > Sync view fresh: read the status once on mount, re-read
 * it every three seconds, and follow the engine's `sync-status` event. Lists
 * track the status — enabled loads them, disabled clears them — because a poll
 * alone would leave a newly connected folder's rows empty until the next event.
 * A status read never fails the view: the catch only records the message.
 */
export function useSyncStatusRefresh(options: {
  applyStatus: (next: SyncStatus) => void;
  loadLists: () => Promise<void>;
  clearLists: () => void;
  setError: (message: string) => void;
}): void {
  const { applyStatus, loadLists, clearLists, setError } = options;

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
  }, [applyStatus, loadLists, clearLists, setError]);

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
  }, [applyStatus, setError]);

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
}
