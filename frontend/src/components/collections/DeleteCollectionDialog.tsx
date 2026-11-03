import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface DeleteCollectionDialogProps {
  open: boolean;
  name: string;
  /** Backend failure text; the dialog stays open so the user can retry. */
  error?: string | null;
  /** A delete is in flight; both actions wait for it. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Delete confirmation: names the collection so the row in front of the user
 * and the dialog agree, and repeats the local-first promise that the books
 * stay in the library. Cancel (or Escape) closes it and does nothing else.
 */
export function DeleteCollectionDialog({
  open,
  name,
  error = null,
  busy = false,
  onConfirm,
  onCancel,
}: DeleteCollectionDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="delete-collection-dialog" className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{`Delete ${name}?`}</DialogTitle>
          <DialogDescription>
            {`The collection ${name} is removed, but its books stay in the library with their reading progress and annotations.`}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p
            role="alert"
            data-testid="delete-collection-error"
            className="text-sm text-destructive"
          >
            {`Could not delete ${name}: ${error}`}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="delete-collection-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="delete-collection-confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            Delete Collection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
