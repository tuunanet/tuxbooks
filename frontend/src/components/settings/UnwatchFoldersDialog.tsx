import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { StorageReport } from "@/lib/bridge";

const MAX_LISTED = 3;

type FolderRow = StorageReport["bookLocations"][number];

/**
 * What one Unwatch click will do, read off the watch list alone (ADR 0010).
 * A watched folder owns its whole subtree, so a folder sitting inside one
 * that stays watched has no unwatch of its own: the folder above would bring
 * its books straight back. The dialog answers that with the move that works
 * (take the folder above), never with hidden state the user cannot see or
 * undo. Computed once so the promise in this dialog, the folders it lists,
 * and the payload the sidecar gets cannot disagree.
 */
export interface UnwatchPlan {
  /** What the dialog has to ask: nothing, or the steer, or the cascade. */
  kind: "plain" | "steer" | "ask";
  /** Watched folders above the selection; the sidecar refuses without them. */
  ancestors: string[];
  /** Watched folders inside the selection, kept unless the user cascades. */
  inside: string[];
  /** Whether a watched folder inside the selection goes too. */
  cascade: boolean;
  /** Every folder this unwatch removes: the selection plus what the plan adds. */
  folders: FolderRow[];
  /** Exactly what to send. */
  paths: string[];
  /** What the plan adds on top of the selection, for the steer's wording. */
  extraFolders: number;
  extraBooks: number;
}

interface UnwatchFoldersDialogProps {
  open: boolean;
  plan: UnwatchPlan;
  onPlanChange: (plan: UnwatchPlan) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function steerWording(plan: UnwatchPlan): string {
  const above =
    plan.ancestors.length === 1
      ? `the watched folder ${plan.ancestors[0]}`
      : `${plan.ancestors.length} watched folders above them`;
  return (
    `${above} still watches everything under it, so these books would come ` +
    `back the next time a file there changes. Unwatching them goes further: ` +
    `${plural(plan.extraFolders, "more folder")} and ` +
    `${plural(plan.extraBooks, "more book")}.`
  );
}

export function UnwatchFoldersDialog({
  open,
  plan,
  onPlanChange,
  onConfirm,
  onCancel,
  busy = false,
}: UnwatchFoldersDialogProps) {
  const several = plan.folders.length > 1;
  const books = plan.folders.reduce((total, folder) => total + folder.bookCount, 0);
  const title = several
    ? `Unwatch ${plan.folders.length} folders?`
    : `Unwatch ${plan.folders[0]?.path ?? ""}?`;
  const scope = several ? "these folders" : "this folder";
  const one = books === 1;
  const noun = one ? "book" : "books";
  const body =
    books === 0
      ? `No books live in ${scope}.`
      : `The ${books} ${noun} in ${scope} ${one ? "is" : "are"} removed from your library, along with ${one ? "its" : "their"} reading progress and annotations.`;

  const confirmLabel =
    plan.kind === "steer" && plan.ancestors.length === 1
      ? `Unwatch ${plan.ancestors[0]} too`
      : plan.kind === "steer"
        ? "Unwatch those too"
        : several
          ? `Unwatch ${plan.folders.length} Folders`
          : "Unwatch";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="unwatch-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{`${body} Your files on disk stay untouched.`}</DialogDescription>
        </DialogHeader>

        {several && (
          <ul data-testid="unwatch-names" className="space-y-1">
            {plan.folders.slice(0, MAX_LISTED).map((folder) => (
              <li
                key={folder.path}
                title={folder.path}
                className="truncate font-mono text-xs text-muted-foreground"
              >
                {folder.path}
              </li>
            ))}
          </ul>
        )}
        {plan.folders.length > MAX_LISTED && (
          <p data-testid="unwatch-overflow" className="text-xs text-muted-foreground">
            {`+${plan.folders.length - MAX_LISTED} more`}
          </p>
        )}

        {plan.kind === "steer" && (
          <p data-testid="unwatch-steer" className="text-xs text-muted-foreground">
            {steerWording(plan)}
          </p>
        )}

        {plan.kind === "ask" && (
          <div data-testid="unwatch-ask" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {plan.inside.length === 1
                ? "A folder inside is watched on its own and keeps syncing without this one. Unwatch it too?"
                : `${plan.inside.length} folders inside are watched on their own and keep syncing without these. Unwatch them too?`}
            </p>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={plan.cascade ? "yes" : "no"}
              onValueChange={(next) => {
                if (next) onPlanChange({ ...plan, cascade: next === "yes" });
              }}
            >
              <ToggleGroupItem
                data-testid="unwatch-keep-inside"
                value="no"
                aria-label="Keep the folders inside watched"
              >
                No, keep them watched
              </ToggleGroupItem>
              <ToggleGroupItem
                data-testid="unwatch-drop-inside"
                value="yes"
                aria-label="Unwatch the folders inside too"
              >
                Yes, unwatch them too
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="unwatch-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="unwatch-confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
