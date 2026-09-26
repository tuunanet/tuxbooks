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
  /**
   * How many books the current selection holds. At one the menu is the
   * single-book menu; above one it switches to the count-aware bulk menu.
   */
  selectionCount?: number;
  onOpen?: (bookId: number) => void;
  onRead?: (bookId: number) => void;
  onLocate?: (bookId: number) => void;
  onEditMetadata?: (bookId: number) => void;
  onRemove?: (bookId: number) => void;
  onAddToCollection?: (bookId: number, collectionId: number) => void;
  onRemoveFromCollection?: (bookId: number, collectionId: number) => void;
  onMarkFinished?: (bookId: number) => void;
  onReveal?: (bookId: number) => void;
  /** Bulk removal of the whole selection; opens the confirmation dialog. */
  onBulkRemove?: () => void;
  /** Ids in the current selection; the bulk collection submenus read it. */
  selectedBookIds?: number[];
  /** Bulk add: adds every selected book the collection is still missing. */
  onBulkAddToCollection?: (collection: CollectionSummary) => void;
  /** Bulk remove: drops the selected members only. */
  onBulkRemoveFromCollection?: (collection: CollectionSummary) => void;
  /** Bulk mark-as-finished: flags every selected book that is not finished. */
  onBulkMarkFinished?: () => void;
  children: ReactNode;
}

interface CollectionSubmenusProps {
  /** Collections the book or the selection can still join. */
  joinable: CollectionSummary[];
  /** Collections the book or the selection already belongs to. */
  memberOf: CollectionSummary[];
  /** False once the library holds no collections at all. */
  hasCollections: boolean;
  /** What the add submenu says when nothing is joinable any more. */
  fullLabel: string;
  fullText: string;
  onAdd: (collection: CollectionSummary) => void;
  onRemove: (collection: CollectionSummary) => void;
}

/**
 * The Add to Collection and Remove from Collection submenus, shared by the
 * single-book menu and the bulk menu. They differ only in which collections
 * each list and in what the disabled add row says, so both come in as props
 * and the markup stays in one place.
 */
function CollectionSubmenus({
  joinable,
  memberOf,
  hasCollections,
  fullLabel,
  fullText,
  onAdd,
  onRemove,
}: CollectionSubmenusProps) {
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="context-add-to-collection">
          Add to Collection
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {joinable.length === 0 ? (
            <ContextMenuItem
              disabled
              data-testid="context-no-collections"
              title={hasCollections ? fullLabel : "Create a collection from the sidebar first"}
            >
              {hasCollections ? fullText : "No collections yet"}
            </ContextMenuItem>
          ) : (
            joinable.map((collection) => (
              <ContextMenuItem
                key={collection.id}
                data-testid={`context-add-to-collection-${collection.id}`}
                onSelect={() => onAdd(collection)}
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
                onSelect={() => onRemove(collection)}
              >
                {collection.name}
              </ContextMenuItem>
            ))
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}

/**
 * Right-click actions for a book: Open/Continue Reading, removal from the
 * library (local-first: the source file on disk is never touched), metadata
 * editing (milestone 7), collection membership (milestone 10), the
 * mark-as-finished flag, and — for books whose file disappeared — the Locate
 * File reconnection flow.
 *
 * With two or more books selected the menu switches to the bulk set: the
 * counted destructive removal, the selection-wide collection submenus, and
 * the selection-wide mark-as-finished entry.
 */
export function BookContextMenu({
  book,
  collections,
  selectionCount = 1,
  onOpen,
  onRead,
  onLocate,
  onEditMetadata,
  onRemove,
  onAddToCollection,
  onRemoveFromCollection,
  onMarkFinished,
  onReveal,
  onBulkRemove,
  selectedBookIds = [],
  onBulkAddToCollection,
  onBulkRemoveFromCollection,
  onBulkMarkFinished,
  children,
}: BookContextMenuProps) {
  const memberOf = collections.filter((collection) => collection.bookIds.includes(book.id));
  const joinable = collections.filter((collection) => !collection.bookIds.includes(book.id));
  const bulkJoinable = collections.filter((collection) =>
    selectedBookIds.some((id) => !collection.bookIds.includes(id)),
  );
  const bulkMemberOf = collections.filter((collection) =>
    selectedBookIds.some((id) => collection.bookIds.includes(id)),
  );
  const finished = book.progressPercent !== null && book.progressPercent >= 100;
  const bulkCount = selectionCount > 1 ? selectionCount : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        aria-label={
          bulkCount === null
            ? `Actions for ${book.title}`
            : `Actions for ${bulkCount} selected books`
        }
      >
        {bulkCount === null ? (
          <>
            {!book.available && (
              <ContextMenuItem
                data-testid="context-locate-file"
                onSelect={() => onLocate?.(book.id)}
              >
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
            <CollectionSubmenus
              joinable={joinable}
              memberOf={memberOf}
              hasCollections={collections.length > 0}
              fullLabel="This book is in every collection"
              fullText="No other collections"
              onAdd={(collection) => onAddToCollection?.(book.id, collection.id)}
              onRemove={(collection) => onRemoveFromCollection?.(book.id, collection.id)}
            />
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
          </>
        ) : (
          <>
            <CollectionSubmenus
              joinable={bulkJoinable}
              memberOf={bulkMemberOf}
              hasCollections={collections.length > 0}
              fullLabel="This selection is in every collection"
              fullText="All books are in every collection"
              onAdd={(collection) => onBulkAddToCollection?.(collection)}
              onRemove={(collection) => onBulkRemoveFromCollection?.(collection)}
            />
            <ContextMenuItem
              data-testid="context-mark-finished"
              onSelect={() => onBulkMarkFinished?.()}
            >
              Mark as Finished
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="context-remove-books"
              variant="destructive"
              onSelect={() => onBulkRemove?.()}
            >
              {`Remove ${bulkCount} Books from Library`}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
