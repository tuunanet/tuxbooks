import { Button } from "@/components/ui/button";
import { useAppDispatch, useAppState } from "@/state/appState";
import { useSyncAttention } from "@/state/syncAttentionState";

const TOAST_MESSAGE = "Sync needs attention. Review it in Settings.";

/**
 * The live region is always mounted so a screen reader announces the message
 * when it appears. The card is hidden in the reader, where it would cover the
 * page-turn controls, and the container never captures pointer input.
 */
export function SyncAttentionToast() {
  const app = useAppState();
  const dispatch = useAppDispatch();
  const { toastVisible, dismissToast } = useSyncAttention();
  const showCard = toastVisible && app.view !== "reader";

  return (
    <div
      data-testid="sync-attention-live"
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
    >
      {showCard ? (
        <div
          data-testid="sync-attention-toast"
          className="pointer-events-auto flex w-full max-w-sm flex-col gap-3 rounded-lg border bg-background p-4 text-sm shadow-lg"
        >
          <p>{TOAST_MESSAGE}</p>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => dispatch({ type: "select-section", section: { kind: "settings" } })}
            >
              Open Settings
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Dismiss sync attention notice"
              onClick={dismissToast}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
