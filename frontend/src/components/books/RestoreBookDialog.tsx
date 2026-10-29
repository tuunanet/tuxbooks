import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BookTrashEntry, RestoreConflict, RestoreMode } from "@/types/domain";

interface RestoreBookDialogProps {
  open: boolean;
  entry: BookTrashEntry | null;
  conflict: RestoreConflict | null;
  busy?: boolean;
  onChoose: (mode: RestoreMode) => void;
  onCancel: () => void;
}

function titleOf(entry: BookTrashEntry | null): string {
  const title = entry?.title?.trim();
  return title === undefined || title === "" ? "this book" : `"${title}"`;
}

/**
 * Restore conflict (ADR 0014 D5): the fresh identity already has new progress
 * or annotations, so the user must say which state wins. Silence would merge
 * two histories without consent.
 */
export function RestoreBookDialog({
  open,
  entry,
  conflict,
  busy = false,
  onChoose,
  onCancel,
}: RestoreBookDialogProps) {
  const progress =
    conflict?.progressPercent === null || conflict?.progressPercent === undefined
      ? null
      : `${Math.round(conflict.progressPercent)}% progress`;
  const annotations =
    conflict === null
      ? null
      : `${conflict.annotationCount} ${
          conflict.annotationCount === 1 ? "annotation" : "annotations"
        }`;
  const current = [progress, annotations].filter((part) => part !== null).join(" and ");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="restore-book-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{`Restore ${titleOf(entry)}?`}</DialogTitle>
          <DialogDescription>
            {`The current copy already has new reading data${
              current === "" ? "" : ` (${current})`
            }. Choose which state the restored book keeps.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          <div className="rounded-md border p-3">
            <p className="font-medium">Replace</p>
            <p className="mt-1 text-muted-foreground">
              The forgotten book wins. Its progress and annotations replace everything the current
              copy has.
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="font-medium">Keep</p>
            <p className="mt-1 text-muted-foreground">
              The current book wins. Its progress and annotations stay, and the forgotten record is
              discarded.
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="font-medium">Merge</p>
            <p className="mt-1 text-muted-foreground">
              The newer progress wins and annotations from both copies are kept.
            </p>
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="restore-book-cancel"
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
              data-testid="restore-book-keep"
              disabled={busy}
              onClick={() => onChoose("keep")}
            >
              Keep Current
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="restore-book-merge"
              disabled={busy}
              onClick={() => onChoose("merge")}
            >
              Merge
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="restore-book-replace"
              disabled={busy}
              onClick={() => onChoose("replace")}
            >
              Replace with Old
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
