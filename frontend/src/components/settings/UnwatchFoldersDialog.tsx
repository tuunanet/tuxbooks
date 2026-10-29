import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type { StorageReport, UnwatchProgress } from "@/lib/bridge";

const MAX_LISTED = 3;

type FolderRow = StorageReport["bookLocations"][number];

interface UnwatchFoldersDialogProps {
  open: boolean;
  /** Every folder this unwatch removes. Never nested: the list stays flat. */
  folders: FolderRow[];
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Removal counts while the purge runs; null before it starts. */
  progress?: UnwatchProgress | null;
  /** Why the last attempt failed; stays on screen so the user can retry. */
  error?: string | null;
}

function titleFor(folders: FolderRow[]): string {
  return folders.length > 1
    ? `Unwatch ${folders.length} folders?`
    : `Unwatch ${folders[0]?.path ?? ""}?`;
}

/** The statement of what this unwatch changes, which is the whole selection. */
function bodyFor(folders: FolderRow[], books: number): string {
  const scope = folders.length > 1 ? "these folders" : "this folder";
  if (books === 0) return `No books live in ${scope}.`;
  const one = books === 1;
  return `The ${books} ${one ? "book" : "books"} in ${scope} ${one ? "leaves" : "leave"} your library. ${one ? "Its" : "Their"} reading progress and annotations are kept.`;
}

function confirmLabelFor(folders: FolderRow[]): string {
  return folders.length > 1 ? `Unwatch ${folders.length} Folders` : "Unwatch";
}

/**
 * The unwatch confirmation (ADR 0010). The watch list holds no folder inside
 * another, so every folder named here is one the user ticked and one that
 * can be unwatched on its own. There is nothing else to ask: a folder above
 * would not be in the list, and a folder below would not exist as a row.
 */
export function UnwatchFoldersDialog({
  open,
  folders,
  onConfirm,
  onCancel,
  busy = false,
  progress = null,
  error = null,
}: UnwatchFoldersDialogProps) {
  const several = folders.length > 1;
  const books = folders.reduce((total, folder) => total + folder.bookCount, 0);
  const removing = busy && progress !== null && progress.total > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="unwatch-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{titleFor(folders)}</DialogTitle>
          <DialogDescription>{`${bodyFor(folders, books)} Your files on disk stay untouched.`}</DialogDescription>
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

        {removing && (
          <div data-testid="unwatch-progress" className="space-y-1.5">
            <Progress
              aria-label="Unwatch progress"
              value={Math.min(100, Math.round((progress.removed / progress.total) * 100))}
            />
            <p aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
              {`Removing ${progress.removed} of ${progress.total} books`}
            </p>
          </div>
        )}

        {error && (
          <p data-testid="unwatch-error" role="alert" className="text-xs text-destructive">
            {error}
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
            {confirmLabelFor(folders)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
