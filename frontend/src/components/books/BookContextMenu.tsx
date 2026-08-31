import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { Book } from "@/types/domain";

interface BookContextMenuProps {
  book: Book;
  onOpen?: (bookId: number) => void;
  onRead?: (bookId: number) => void;
  children: ReactNode;
}

/**
 * Right-click actions for a book. Only Open (book detail) and Continue
 * Reading (reader) have a real flow behind them. The collection entries are
 * submenu shells: the structure is real, the persistence is not, and the
 * disabled entries say so instead of pretending.
 */
export function BookContextMenu({ book, onOpen, onRead, children }: BookContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label={`Actions for ${book.title}`}>
        <ContextMenuItem data-testid="context-open" onSelect={() => onOpen?.(book.id)}>
          Open
        </ContextMenuItem>
        <ContextMenuItem data-testid="context-continue-reading" onSelect={() => onRead?.(book.id)}>
          Continue Reading
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid="context-add-to-collection">
            Add to Collection
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              disabled
              title="Collections are not connected to the backend yet"
              data-testid="context-no-collections"
            >
              No collections yet
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem
          disabled
          title="Collections are not connected to the backend yet"
          data-testid="context-remove-from-collection"
        >
          Remove from Collection
        </ContextMenuItem>
        <ContextMenuItem disabled title="Reading-progress persistence is not wired up yet">
          Mark as Finished
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled title="Metadata editing is not implemented yet">
          Edit Metadata
        </ContextMenuItem>
        <ContextMenuItem disabled title="Revealing files is not wired up yet">
          Show in File Manager
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled variant="destructive" title="Removing books is not wired up yet">
          Remove from Library
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
