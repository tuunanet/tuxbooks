import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface EraseBookDialogProps {
  open: boolean;
  title?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Erase closes a Forgotten book's trash entry without restoring it, before
 * the 30-day window would. Unlike Restore there is no way back: the snapshot
 * is discarded here and on every synced machine.
 */
export function EraseBookDialog({ open, title, onConfirm, onCancel }: EraseBookDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="erase-book-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Erase this forgotten book?</DialogTitle>
          <DialogDescription>
            {title === undefined
              ? "This permanently deletes the record and its reading progress, annotations, collection membership, metadata overrides, and provider links."
              : `This permanently deletes ${title}'s record and its reading progress, annotations, collection membership, metadata overrides, and provider links.`}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">What stays</p>
          <p className="mt-1 text-muted-foreground">
            Your files on disk are not touched, and the current library book, if one replaced this
            record, keeps its file and state.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Erasing skips the rest of the 30-day window and cannot be undone.
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="erase-book-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="erase-book-confirm"
            onClick={onConfirm}
          >
            Erase Book
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
