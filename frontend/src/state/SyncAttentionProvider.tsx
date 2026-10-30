import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getSyncStatus, onSyncStatus, type SyncStatus } from "@/lib/bridge";
import { SyncAttentionContext, needsSyncAttention } from "./syncAttentionState";

/**
 * Keeps sync attention visible for the whole shell. The engine pushes a status
 * event after a pass, retry, resolve, or connect/disconnect; one read on mount
 * covers a page opened after the last event. There is no timer, so a poll can
 * never re-open the toast.
 *
 * The first status is a state, not a transition: the toast opens only when
 * attention goes from false to true. It closes when attention clears, and a
 * dismissed toast stays hidden until attention clears and later returns.
 *
 * A status event is newer than the mount read, so once an event has applied
 * the read result is ignored even if it resolves later.
 */
export function SyncAttentionProvider({ children }: { children: ReactNode }) {
  const [attention, setAttention] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);
  // null until the first status arrives.
  const previousAttention = useRef<boolean | null>(null);
  const dismissed = useRef(false);

  const applyStatus = useCallback((status: SyncStatus) => {
    const next = needsSyncAttention(status);
    const previous = previousAttention.current;
    previousAttention.current = next;
    setAttention(next);

    if (!next) {
      dismissed.current = false;
      setToastVisible(false);
      return;
    }
    if (previous === false && !dismissed.current) setToastVisible(true);
  }, []);

  const dismissToast = useCallback(() => {
    dismissed.current = true;
    setToastVisible(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let eventApplied = false;
    let unlisten: (() => void) | undefined;

    void onSyncStatus((status) => {
      if (cancelled) return;
      eventApplied = true;
      applyStatus(status);
    }).then((stop) => {
      unlisten = stop;
      if (cancelled) stop();
    });

    void getSyncStatus()
      .then((status) => {
        // The event carries the newer snapshot; an older mount read must not
        // clear a live dot or fake a first-load transition.
        if (!cancelled && !eventApplied) applyStatus(status);
      })
      .catch(() => {
        // A failed status read must not break the shell. The next event, or a
        // later mount, recovers.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyStatus]);

  const value = useMemo(
    () => ({ attention, toastVisible, dismissToast }),
    [attention, toastVisible, dismissToast],
  );

  return <SyncAttentionContext.Provider value={value}>{children}</SyncAttentionContext.Provider>;
}
