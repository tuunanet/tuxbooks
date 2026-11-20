import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LocateConflict } from "@/types/domain";

interface LocateConflictDialogProps {
  conflict: LocateConflict;
  open: boolean;
  busy: boolean;
  error: string | null;
  onOpenOwner: () => void;
  onMoveToHistory: () => void;
  onLinkEdition: () => void;
  onCancel: () => void;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What the user is about to resolve, in the dialog's own words. */
function stateSummary(conflict: LocateConflict): string {
  const state = conflict.candidateState;
  const bits: string[] = [];
  if (state.annotations > 0) {
    bits.push(
      `${state.annotations} ${state.annotations === 1 ? "highlight or bookmark" : "highlights and bookmarks"}`,
    );
  }
  if (state.hasProgress) {
    bits.push(
      state.progressPercent === null
        ? "a saved reading position"
        : `${Math.round(state.progressPercent)}% reading progress`,
    );
  }
  if (state.collections > 0) {
    bits.push(
      `${state.collections} collection ${state.collections === 1 ? "membership" : "memberships"}`,
    );
  }
  if (state.hasMetadataOverrides) bits.push("metadata edits");
  if (state.providerLinks > 0) {
    bits.push(`${state.providerLinks} provider ${state.providerLinks === 1 ? "link" : "links"}`);
  }
  if (state.editionLinks > 0) {
    bits.push(`${state.editionLinks} edition ${state.editionLinks === 1 ? "link" : "links"}`);
  }
  return `This entry has ${joinList(bits)}.`;
}

/**
 * The third Locate File case: the picked file already belongs to another
 * entry, but this entry has state that a different-bytes merge could
 * misplace. Every choice here is lossless; none of them merges silently.
 */
export function LocateConflictDialog({
  conflict,
  open,
  busy,
  error,
  onOpenOwner,
  onMoveToHistory,
  onLinkEdition,
  onCancel,
}: LocateConflictDialogProps) {
  const ownerTitle = conflict.owner.title.trim() || "the existing entry";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent data-testid="locate-conflict-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>This file is already in your library</DialogTitle>
          <DialogDescription>
            {`The picked file belongs to "${ownerTitle}". The two files are not identical, so moving this entry's highlights and bookmarks onto the new copy could misplace them.`}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <p>{stateSummary(conflict)}</p>
          <p className="mt-1 text-muted-foreground">Nothing is removed unless you choose it.</p>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <p>
            <span className="font-medium">Open {`"${ownerTitle}"`}</span> keeps both entries and
            opens the readable copy.
          </p>
          <p>
            <span className="font-medium">Move to Reading history</span> clears this library entry
            and keeps its state for a later relink.
          </p>
          <p>
            <span className="font-medium">Link as an edition</span> keeps both entries and leaves
            this entry's highlights and reading position where they are.
          </p>
        </div>
        {error && (
          <p data-testid="locate-conflict-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="locate-conflict-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="locate-conflict-link"
              disabled={busy}
              onClick={onLinkEdition}
            >
              Link as an edition
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="locate-conflict-history"
              disabled={busy}
              onClick={onMoveToHistory}
            >
              Move to Reading history
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="locate-conflict-open"
              disabled={busy}
              onClick={onOpenOwner}
            >
              Open {`"${ownerTitle}"`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
