import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** How many folder names the dialog spells out before it overflows. */
const MAX_LISTED = 3;

/** One folder on its way out of the watch list. */
interface UnwatchTarget {
  path: string;
  bookCount: number;
}

interface UnwatchFoldersDialogProps {
  open: boolean;
  folders: UnwatchTarget[];
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

/**
 * The single confirmation in front of Unwatch, and the only outcome there
 * is: the folders leave the watch list and every book they own leaves the
 * catalog with them, so the copy says exactly that — how many books go,
 * that their reading progress and annotations go with them, and that the
 * files on disk stay untouched. It names what is affected (one folder by
 * name, several as a count plus a list that overflows). A folder with no
 * books has nothing to lose, so that case keeps its own copy. Cancel (or
 * Escape) closes it and does nothing else.
 */
export function UnwatchFoldersDialog({
  open,
  folders,
  onConfirm,
  onCancel,
  busy = false,
}: UnwatchFoldersDialogProps) {
  const several = folders.length > 1;
  const books = folders.reduce((total, folder) => total + folder.bookCount, 0);
  const title = several
    ? `Unwatch ${folders.length} folders?`
    : `Unwatch ${folders[0]?.path ?? ""}?`;
  const scope = several ? "these folders" : "this folder";
  const one = books === 1;
  const noun = one ? "book" : "books";
  const body =
    books === 0
      ? `No books live in ${scope}.`
      : `The ${books} ${noun} in ${scope} ${one ? "is" : "are"} removed from your library, along with ${one ? "its" : "their"} reading progress and annotations.`;

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
            {folders.slice(0, MAX_LISTED).map((folder) => (
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
        {folders.length > MAX_LISTED && (
          <p data-testid="unwatch-overflow" className="text-xs text-muted-foreground">
            {`+${folders.length - MAX_LISTED} more`}
          </p>
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
            {several ? `Unwatch ${folders.length} Folders` : "Unwatch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
