import { SMART_SECTION_TITLES } from "@/components/library/sections";
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
 * The single confirmation in front of Unwatch. It names what is affected —
 * one folder by name, several as a count plus a list that overflows — says
 * how many books are involved, and repeats the local-first promise twice:
 * the books stay (as loose books), and the files on disk stay where they
 * are. Cancel (or Escape) closes it and does nothing else.
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
  // The kept books land in the loose-books section, so the dialog names it
  // rather than restating it — a rename there must not strand this copy.
  const looseSection = SMART_SECTION_TITLES["outside-watched"];
  const keep =
    books === 0
      ? `No books live in ${several ? "these folders" : "this folder"}.`
      : books === 1
        ? `1 book stays in your library as a loose book under “${looseSection}”.`
        : `${books} books stay in your library as loose books under “${looseSection}”.`;

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
          <DialogDescription>{`${keep} Your files on disk stay untouched.`}</DialogDescription>
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
