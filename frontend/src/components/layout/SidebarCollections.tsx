import { useState } from "react";
import { ChevronDown, Folder, GripVertical, MoreHorizontal, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  forgetCollection,
  moveCollection,
  pinCollection,
  placeCollection,
  resolveCollectionGroups,
  setUnpinnedCollapsed,
  unpinCollection,
  type CollectionGroupId,
  type CollectionRef,
} from "@/lib/collectionPreferences";
import { CollectionDialog } from "@/components/collections/CollectionDialog";
import { DeleteCollectionDialog } from "@/components/collections/DeleteCollectionDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCollectionActions } from "@/hooks/useCollectionActions";
import { useCollectionPreferences } from "@/hooks/useCollectionPreferences";
import { useLibrary } from "@/hooks/useLibrary";
import type { CollectionSelectMode, LibrarySection } from "@/state/appState";
import { GroupLabel, ItemButton, ItemLabel } from "@/components/layout/SidebarItems";

interface SidebarCollectionsProps {
  active: LibrarySection;
  onSectionChange: (section: LibrarySection) => void;
  /** A collection row click; `visibleIds` is the current sidebar order. */
  onCollectionSelect: (
    collectionId: number,
    mode: CollectionSelectMode,
    visibleIds: number[],
  ) => void;
  /** A collection was deleted; prune it from the active collection place. */
  onCollectionDeleted: (collectionId: number) => void;
}

/** Where a pointer currently is, in terms of the target group and row gap. */
interface CollectionDropTarget {
  group: CollectionGroupId;
  index: number;
}

function dropTargetAt(clientX: number, clientY: number): CollectionDropTarget | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const element = document.elementFromPoint(clientX, clientY);
  const groupElement = element?.closest<HTMLElement>("[data-collection-group]");
  if (!groupElement) return null;

  const group = groupElement.dataset.collectionGroup;
  if (group !== "pinned" && group !== "unpinned") return null;

  const rows = Array.from(groupElement.querySelectorAll<HTMLElement>("[data-collection-row]"));
  let index = rows.length;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row) continue;
    const rect = row.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      index = rowIndex;
      break;
    }
  }
  return { group, index };
}

interface CollectionRowProps {
  collection: CollectionRef;
  pinned: boolean;
  active: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  dragging: boolean;
  onSelect: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onRename: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onSetPinned: (pinned: boolean) => void;
  onDragStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onDragMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onDragEnd: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onDragCancel: (event: React.PointerEvent<HTMLButtonElement>) => void;
}

/**
 * A collection row: click to open its place, drag the left handle to reorder,
 * or use the actions menu (pointer right-click or keyboard) for Move up, Move
 * down, Rename, Pin, and Unpin. These actions always target this row, never
 * the collection multi-selection.
 */
function CollectionRow({
  collection,
  pinned,
  active,
  canMoveUp,
  canMoveDown,
  dragging,
  onSelect,
  onRename,
  onDelete,
  onMove,
  onSetPinned,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: CollectionRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ItemButton
        active={active}
        onClick={onSelect}
        leading={
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Reorder ${collection.name}`}
            title={`Drag to reorder ${collection.name}`}
            data-testid={`collection-drag-${collection.id}`}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragCancel}
            className="absolute top-1/2 left-1 -translate-y-1/2 cursor-grab touch-none rounded p-1 text-muted-foreground opacity-0 transition-opacity outline-none group-hover/item:opacity-100 group-focus-within/item:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <GripVertical className="size-3.5" />
          </button>
        }
        trailing={
          <>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid={`collection-actions-${collection.id}`}
                aria-label={`Actions for ${collection.name}`}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition-opacity outline-none group-hover/item:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <button
              type="button"
              data-testid={`collection-delete-${collection.id}`}
              aria-label={`Delete collection ${collection.name}`}
              title={`Delete ${collection.name} (books are kept)`}
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              className="absolute top-1/2 right-8 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition-opacity outline-none group-hover/item:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Trash2 className="size-3.5" />
            </button>
          </>
        }
        wrapperProps={{
          "data-collection-row": collection.id,
          "data-dragging": dragging ? "true" : undefined,
          onContextMenu: (event) => {
            event.preventDefault();
            setMenuOpen(true);
          },
        }}
      >
        <ItemLabel icon={Folder} testId="collection-item">
          {collection.name}
        </ItemLabel>
      </ItemButton>
      <DropdownMenuContent align="end" aria-label={`Actions for ${collection.name}`}>
        <DropdownMenuItem
          data-testid={`collection-move-up-${collection.id}`}
          disabled={!canMoveUp}
          onSelect={() => onMove(-1)}
        >
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={`collection-move-down-${collection.id}`}
          disabled={!canMoveDown}
          onSelect={() => onMove(1)}
        >
          Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid={`collection-rename-${collection.id}`} onSelect={onRename}>
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {pinned ? (
          <DropdownMenuItem
            data-testid={`collection-unpin-${collection.id}`}
            onSelect={() => onSetPinned(false)}
          >
            Unpin
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            data-testid={`collection-pin-${collection.id}`}
            onSelect={() => onSetPinned(true)}
          >
            Pin
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DragState {
  collectionId: number;
  group: CollectionGroupId;
  pointerId: number;
}

/**
 * The pinned and unpinned collection sections: selection, drag reorder, the
 * row actions menu, and the create, rename, and delete dialogs. Everything
 * collection-specific in the sidebar lives here.
 */
export function SidebarCollections({
  active,
  onSectionChange,
  onCollectionSelect,
  onCollectionDeleted,
}: SidebarCollectionsProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CollectionRef | null>(null);
  const [deleting, setDeleting] = useState<CollectionRef | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<CollectionDropTarget | null>(null);
  const { collections } = useLibrary();
  const { create, rename, remove } = useCollectionActions();
  const { preferences, save } = useCollectionPreferences(collections);

  const groups = resolveCollectionGroups(collections, preferences);
  // Selection ranges follow what is on screen, including across the
  // Pinned/Unpinned boundary while Unpinned is expanded.
  const visibleCollectionIds = (
    preferences.unpinnedCollapsed ? groups.pinned : [...groups.pinned, ...groups.unpinned]
  ).map((collection) => collection.id);
  const activeCollectionIds = active.kind === "collection" ? active.ids : [];

  const selectCollection = (collectionId: number, event: React.MouseEvent<HTMLButtonElement>) => {
    const mode: CollectionSelectMode = event.shiftKey
      ? "range"
      : event.ctrlKey || event.metaKey
        ? "toggle"
        : "replace";
    onCollectionSelect(collectionId, mode, visibleCollectionIds);
  };

  const beginDrag = (
    collectionId: number,
    group: CollectionGroupId,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ collectionId, group, pointerId: event.pointerId });
    setDropTarget(null);
  };

  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    setDropTarget(dropTargetAt(event.clientX, event.clientY));
  };

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const target = dropTargetAt(event.clientX, event.clientY) ?? dropTarget;
    if (event.currentTarget.hasPointerCapture?.(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    if (target) {
      // dropTargetAt counts the dragged row too. Once it is lifted out, every
      // gap after its old position shifts down by one.
      let index = target.index;
      if (target.group === drag.group) {
        const source = drag.group === "pinned" ? groups.pinned : groups.unpinned;
        const sourceIndex = source.findIndex((collection) => collection.id === drag.collectionId);
        if (sourceIndex >= 0 && target.index > sourceIndex) index -= 1;
      }
      save(placeCollection(preferences, collections, drag.collectionId, target.group, index));
    }
    setDrag(null);
    setDropTarget(null);
  };

  const cancelDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (drag && event.currentTarget.hasPointerCapture?.(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    setDrag(null);
    setDropTarget(null);
  };

  const renderCollection = (
    collection: CollectionRef,
    group: CollectionGroupId,
    index: number,
    groupLength: number,
  ) => {
    const pinned = group === "pinned";
    return (
      <CollectionRow
        key={collection.id}
        collection={collection}
        pinned={pinned}
        active={activeCollectionIds.includes(collection.id)}
        canMoveUp={index > 0}
        canMoveDown={index < groupLength - 1}
        dragging={drag?.collectionId === collection.id}
        onSelect={(event) => selectCollection(collection.id, event)}
        onRename={() => setEditing(collection)}
        onDelete={() => {
          setDeleteError(null);
          setDeleting(collection);
        }}
        onMove={(direction) =>
          save(moveCollection(preferences, collections, collection.id, direction))
        }
        onSetPinned={(nextPinned) =>
          save(
            nextPinned
              ? pinCollection(preferences, collection.id)
              : unpinCollection(preferences, collection.id),
          )
        }
        onDragStart={(event) => beginDrag(collection.id, group, event)}
        onDragMove={moveDrag}
        onDragEnd={finishDrag}
        onDragCancel={cancelDrag}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {groups.pinned.length > 0 && (
        <section
          data-testid="pinned-collections"
          data-collection-group="pinned"
          aria-label="Pinned Collections"
          className={cn(
            "rounded-md transition-colors",
            drag && dropTarget?.group === "pinned" && "bg-accent/40",
          )}
        >
          <GroupLabel>Pinned Collections</GroupLabel>
          <div className="flex flex-col gap-0.5">
            {groups.pinned.map((collection, index) =>
              renderCollection(collection, "pinned", index, groups.pinned.length),
            )}
          </div>
        </section>
      )}

      {groups.unpinned.length > 0 && (
        <section
          data-testid="unpinned-collections"
          data-collection-group="unpinned"
          aria-label="Unpinned Collections"
          className={cn(
            "rounded-md transition-colors",
            drag && dropTarget?.group === "unpinned" && "bg-accent/40",
          )}
        >
          <button
            type="button"
            data-testid="unpinned-collections-toggle"
            aria-expanded={!preferences.unpinnedCollapsed}
            onClick={() => save(setUnpinnedCollapsed(preferences, !preferences.unpinnedCollapsed))}
            className="mb-1 flex w-full items-center gap-1 rounded px-3 py-0.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3 transition-transform",
                preferences.unpinnedCollapsed && "-rotate-90",
              )}
            />
            <span>Unpinned Collections ({groups.unpinned.length})</span>
          </button>
          {!preferences.unpinnedCollapsed && (
            <div className="flex flex-col gap-0.5">
              {groups.unpinned.map((collection, index) =>
                renderCollection(collection, "unpinned", index, groups.unpinned.length),
              )}
            </div>
          )}
        </section>
      )}

      <CollectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={async (name) => {
          const result = await create(name);
          if (result.ok && result.collection) {
            onSectionChange({ kind: "collection", ids: [result.collection.id] });
          }
          return result;
        }}
      />
      {editing && (
        <CollectionDialog
          key={editing.id}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
          collection={editing}
          onSubmit={async (name) => rename(editing.id, name)}
          trigger={false}
        />
      )}
      <DeleteCollectionDialog
        open={deleting !== null}
        name={deleting?.name ?? ""}
        error={deleteError}
        busy={deleteBusy}
        onCancel={() => {
          if (deleteBusy) return;
          setDeleting(null);
          setDeleteError(null);
        }}
        onConfirm={() => {
          if (!deleting || deleteBusy) return;
          const deletedId = deleting.id;
          setDeleteError(null);
          setDeleteBusy(true);
          // Wait for the backend before touching device state: a failed
          // delete must leave the row pinned and selected.
          void remove(deletedId).then((result) => {
            setDeleteBusy(false);
            if (!result.ok) {
              setDeleteError(result.error ?? "unknown error");
              return;
            }
            setDeleting(null);
            save(forgetCollection(preferences, deletedId));
            onCollectionDeleted(deletedId);
          });
        }}
      />
    </div>
  );
}
