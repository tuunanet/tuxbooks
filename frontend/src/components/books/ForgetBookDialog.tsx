import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ForgetBookDialogProps {
  open: boolean;
  /** One book keeps the single-book copy; a selection gets the count. */
  count: number;
  /** False when the book has no file and leaves Reading history entirely. */
  keepsFile: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The single confirmation in front of Forget (ADR 0014 D5). It is deliberately
 * different from Remove and Reset: the identity goes, the file may stay, and
 * the whole record is restorable for 30 days.
 */
export function ForgetBookDialog({
  open,
  count,
  keepsFile,
  onConfirm,
  onCancel,
}: ForgetBookDialogProps) {
  const many = count > 1;
  const noun = many ? `${count} books` : "this book";
  const possessive = many ? "their" : "its";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="forget-book-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{many ? `Forget ${count} books?` : "Forget this book?"}</DialogTitle>
          <DialogDescription>
            {`This erases ${noun}'s identity and clears ${possessive} reading progress, annotations, collection membership, metadata overrides, and provider links.`}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">What stays</p>
          <p className="mt-1 text-muted-foreground">
            {keepsFile && !many
              ? "The file and the library entry stay, as a fresh unread book with a new identity."
              : keepsFile
                ? "Files and library entries stay, as fresh unread books with new identities."
                : "Your files on disk are not touched."}
          </p>
          <p className="mt-2 font-medium">What is restorable</p>
          <p className="mt-1 text-muted-foreground">
            {`The old ${many ? "records and their state are" : "record and its state are"} kept in Reading history for 30 days. If the fresh book already has new progress or annotations, restoring asks whether to Replace, Keep, or Merge.`}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Provider links are removed locally; remote provider history is not deleted.
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="forget-book-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="forget-book-confirm"
            onClick={onConfirm}
          >
            {many ? `Forget ${count} Books` : "Forget Book"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
