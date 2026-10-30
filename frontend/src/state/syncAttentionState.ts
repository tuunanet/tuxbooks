import { createContext, useContext } from "react";
import type { SyncStatus } from "@/lib/bridge";

/** What the sidebar dot and the transition toast read from the provider. */
export interface SyncAttentionValue {
  /** True while sync is on and reports an error, an issue, or a conflict. */
  attention: boolean;
  /** True while the transition toast is on screen. */
  toastVisible: boolean;
  /** Hide the toast until attention clears and later returns. */
  dismissToast: () => void;
}

const NO_ATTENTION: SyncAttentionValue = {
  attention: false,
  toastVisible: false,
  dismissToast: () => {},
};

/**
 * Defaults to "nothing needs attention" so a component rendered on its own
 * (a Sidebar test, a preview) still works. The provider overrides this.
 */
export const SyncAttentionContext = createContext<SyncAttentionValue>(NO_ATTENTION);

export function useSyncAttention(): SyncAttentionValue {
  return useContext(SyncAttentionContext);
}

/**
 * Attention means sync is on and the engine reports an error, at least one
 * open issue, or a conflict waiting for a decision. Conflicts are a separate
 * count from issues (docs/SYNC.md). Keeping `enabled` in the condition matches
 * Settings > Sync, which also hides leftover counts while sync is off.
 */
export function needsSyncAttention(status: SyncStatus | null): boolean {
  if (status === null || !status.enabled) return false;
  return status.state === "error" || status.issues > 0 || status.conflicts > 0;
}
