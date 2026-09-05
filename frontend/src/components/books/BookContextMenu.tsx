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
import type { Book, CollectionSummary } from "@/types/domain";

interface BookContextMenuProps {
  book: Book;
  /** All collections; member ones show a check and leave the add submenu. */
  collections: CollectionSummary[];
  onOpen?: (bookId: number) => void;
  onRead?: (bookId: number) => void;
  onLocate?: (bookId: number) => void;
  onEditMetadata?: (bookId: number) => void;
  onRemove?: (bookId: number) => void;
  onAddToCollection?: (bookId: number, collectionId: number) => void;
  onRemoveFromCollection?: (bookId: number, collectionId: number) => void;
  onMarkFinished?: (bookId: number) => void;
  onReveal?: (bookId: number) => void;
  children: ReactNode;
}

/**
 * Right-click actions for a book: Open/Continue Reading, removal from the
 * library (local-first: the source file on disk is never touched), metadata
 * editing (milestone 7), collection membership (milestone 10), the
 * mark-as-finished flag, and — for books whose file disappeared — the Locate
 * File reconnection flow.
 */
export function BookContextMenu({
  book,
  collections,
  onOpen,
  onRead,
  onLocate,
  onEditMetadata,
  onRemove,
  onAddToCollection,
  onRemoveFromCollection,
  onMarkFinished,
  onReveal,
  children,
}: BookContextMenuProps) {
  const memberOf = collections.filter((collection) => collection.bookIds.includes(book.id));
  const joinable = collections.filter((collection) => !collection.bookIds.includes(book.id));
  const finished = book.progressPercent !== null && book.progressPercent >= 100;

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
        <ContextMenuItem
          data-testid="context-mark-finished"
          disabled={finished}
          title={finished ? "Already marked as finished" : undefined}
          onSelect={() => onMarkFinished?.(book.id)}
        >
          {finished ? "Finished" : "Mark as Finished"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid="context-add-to-collection">
            Add to Collection
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {joinable.length === 0 ? (
              <ContextMenuItem
                disabled
                data-testid="context-no-collections"
                title={
                  collections.length === 0
                    ? "Create a collection from the sidebar first"
                    : "This book is in every collection"
                }
              >
                {collections.length === 0 ? "No collections yet" : "No other collections"}
              </ContextMenuItem>
            ) : (
              joinable.map((collection) => (
                <ContextMenuItem
                  key={collection.id}
                  data-testid={`context-add-to-collection-${collection.id}`}
                  onSelect={() => onAddToCollection?.(book.id, collection.id)}
                >
                  {collection.name}
                </ContextMenuItem>
              ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger
            data-testid="context-remove-from-collection"
            disabled={memberOf.length === 0}
          >
            Remove from Collection
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {memberOf.length === 0 ? (
              <ContextMenuItem disabled data-testid="context-not-in-collection">
                Not in a collection
              </ContextMenuItem>
            ) : (
              memberOf.map((collection) => (
                <ContextMenuItem
                  key={collection.id}
                  data-testid={`context-remove-from-collection-${collection.id}`}
                  onSelect={() => onRemoveFromCollection?.(book.id, collection.id)}
                >
                  {collection.name}
                </ContextMenuItem>
              ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid="context-edit-metadata"
          onSelect={() => onEditMetadata?.(book.id)}
        >
          Edit Metadata
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="context-reveal-file"
          disabled={!book.available}
          title={book.available ? undefined : "The source file is unavailable"}
          onSelect={() => onReveal?.(book.id)}
        >
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
