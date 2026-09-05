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
  onLocate?: (bookId: number) => void;
  onEditMetadata?: (bookId: number) => void;
  onRemove?: (bookId: number) => void;
  children: ReactNode;
}

/**
 * Right-click actions for a book. Open/Continue Reading, removal from the
 * library (local-first: the source file on disk is never touched), metadata
 * editing (milestone 7), and — for books whose file disappeared — the
 * Locate File reconnection flow. The collection entries are submenu shells:
 * the structure is real, the persistence is not, and the disabled entries
 * say so instead of pretending.
 */
export function BookContextMenu({
  book,
  onOpen,
  onRead,
  onLocate,
  onEditMetadata,
  onRemove,
  children,
}: BookContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label={`Actions for ${book.title}`}>
        {!book.available && (
          <ContextMenuItem data-testid="context-locate-file" onSelect={() => onLocate?.(book.id)}>
            Locate File…
          </ContextMenuItem>
        )}
        <ContextMenuItem data-testid="context-open" onSelect={() => onOpen?.(book.id)}>
          Open
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="context-continue-reading"
          disabled={!book.available}
          title={book.available ? undefined : "The source file is unavailable"}
          onSelect={() => onRead?.(book.id)}
        >
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
        <ContextMenuItem
          data-testid="context-edit-metadata"
          onSelect={() => onEditMetadata?.(book.id)}
        >
          Edit Metadata
        </ContextMenuItem>
        <ContextMenuItem disabled title="Revealing files is not wired up yet">
          Show in File Manager
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid="context-remove-book"
          variant="destructive"
          onSelect={() => onRemove?.(book.id)}
        >
          Remove from Library
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
