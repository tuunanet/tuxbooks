import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ResetBookDialogProps {
  open: boolean;
  title?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Reset keeps the book and its file; it is the non-destructive way to re-read.
 * The copy names each cleared surface so the difference from Forget is
 * obvious.
 */
export function ResetBookDialog({ open, title, onConfirm, onCancel }: ResetBookDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="reset-book-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset reading data?</DialogTitle>
          <DialogDescription>
            {title === undefined
              ? "This clears reading progress, annotations, collection membership, metadata overrides, and provider links."
              : `This clears ${title}'s reading progress, annotations, collection membership, metadata overrides, and provider links.`}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">What stays</p>
          <p className="mt-1 text-muted-foreground">
            The book keeps its identity and stays in the library or Reading history with its current
            file, if it has one. It becomes unread.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">Reset cannot be undone.</p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="reset-book-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="reset-book-confirm"
            onClick={onConfirm}
          >
            Reset Reading Data
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
