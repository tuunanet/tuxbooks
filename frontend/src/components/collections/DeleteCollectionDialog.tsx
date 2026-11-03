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
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="delete-collection-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="delete-collection-confirm"
            onClick={onConfirm}
          >
            Delete Collection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
