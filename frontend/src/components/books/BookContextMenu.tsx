import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
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
 * Reading (reader) have a real flow behind them; the rest stay disabled
 * until their backend commands exist — no pretend-success actions.
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
        <ContextMenuItem disabled title="Collections are not connected to the backend yet">
          Add to Collection
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
