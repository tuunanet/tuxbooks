import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface BulkRemoveDialogProps {
  open: boolean;
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The single confirmation in front of a bulk Remove: it names the count and
 * repeats the local-first promise — library entries go, the files on disk
 * stay where they are. Cancel (or Escape) closes it and does nothing else.
 */
export function BulkRemoveDialog({ open, count, onConfirm, onCancel }: BulkRemoveDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="bulk-remove-dialog" className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{`Remove ${count} books from the library?`}</DialogTitle>
          <DialogDescription>
            {`The ${count} selected books are removed from your library. Your files on disk stay untouched.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="bulk-remove-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="bulk-remove-confirm"
            onClick={onConfirm}
          >
            {`Remove ${count} Books`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
