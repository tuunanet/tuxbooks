import { useState } from "react";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CollectionDialog } from "@/components/collections/CollectionDialog";
import { GlobalSearch } from "@/components/search/GlobalSearch";
import { useCollectionActions } from "@/hooks/useCollectionActions";
import { useLibrary } from "@/hooks/useLibrary";
import { sameSection, type LibrarySection, type SmartSectionId } from "@/state/appState";

interface SidebarProps {
  active: LibrarySection;
  onSectionChange: (section: LibrarySection) => void;
}

const LIBRARY_ITEMS: { id: SmartSectionId; label: string }[] = [
  { id: "all-books", label: "All Books" },
  { id: "epubs", label: "EPUBs" },
  { id: "pdfs", label: "PDFs" },
  { id: "recently-added", label: "Recently Added" },
  { id: "recently-read", label: "Recently Read" },
  { id: "in-progress", label: "In Progress" },
  { id: "finished", label: "Finished" },
];

function GroupLabel({ children }: { children: string }) {
  return (
    <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

interface ItemButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
  trailing?: React.ReactNode;
}

function ItemButton({ active, onClick, children, disabled, title, trailing }: ItemButtonProps) {
  return (
    <div className="group/item relative">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        aria-current={active ? "true" : undefined}
        className={cn(
          "w-full rounded-md px-3 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
          trailing && "pr-7",
          active
            ? "bg-accent font-medium text-accent-foreground"
            : "text-foreground hover:bg-accent/60",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {children}
      </button>
      {trailing}
    </div>
  );
}

export function Sidebar({ active, onSectionChange }: SidebarProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const { collections } = useLibrary();
  const { create, remove } = useCollectionActions();

  return (
    <aside
      data-testid="sidebar"
      aria-label="Library sidebar"
      className="flex w-56 shrink-0 flex-col border-r bg-muted/40 p-4"
    >
      <div className="mb-5 px-3">
        <h1 className="text-lg font-semibold">tuxbooks</h1>
        <p className="text-xs text-muted-foreground">Local ebook library</p>
      </div>

      <div className="mb-5">
        <GlobalSearch />
      </div>

      <nav
        aria-label="Library navigation"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto"
      >
        <div>
          <GroupLabel>Library</GroupLabel>
          <div className="flex flex-col gap-0.5">
            {LIBRARY_ITEMS.map((item) => {
              const section: LibrarySection = { kind: "smart", id: item.id };
              return (
                <ItemButton
                  key={item.id}
                  active={sameSection(section, active)}
                  onClick={() => onSectionChange(section)}
                >
                  {item.label}
                </ItemButton>
              );
            })}
          </div>
        </div>

        <div>
          <GroupLabel>Collections</GroupLabel>
          <div className="flex flex-col gap-0.5">
            {collections.map((collection) => {
              const section: LibrarySection = { kind: "collection", id: collection.id };
              return (
                <ItemButton
                  key={collection.id}
                  active={sameSection(section, active)}
                  onClick={() => onSectionChange(section)}
                  trailing={
                    <button
                      type="button"
                      data-testid={`collection-delete-${collection.id}`}
                      aria-label={`Delete collection ${collection.name}`}
                      title={`Delete ${collection.name} (books are kept)`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void remove(collection.id);
                        if (sameSection(section, active)) {
                          onSectionChange({ kind: "smart", id: "all-books" });
                        }
                      }}
                      className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition-opacity outline-none group-hover/item:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  }
                >
                  <span data-testid="collection-item" className="block truncate">
                    {collection.name}
                  </span>
                </ItemButton>
              );
            })}
            <CollectionDialog
              open={createOpen}
              onOpenChange={setCreateOpen}
              onCreate={async (name) => {
                const result = await create(name);
                // A fresh collection is empty; land the user in its section
                // so the creation visibly did something.
                if (result.ok && result.collection) {
                  onSectionChange({ kind: "collection", id: result.collection.id });
                }
                return result;
              }}
            />
          </div>
        </div>
      </nav>

      <div className="mt-4 border-t pt-3">
        <ItemButton
          active={active.kind === "settings"}
          onClick={() => onSectionChange({ kind: "settings" })}
        >
          Settings
        </ItemButton>
      </div>
    </aside>
  );
}
