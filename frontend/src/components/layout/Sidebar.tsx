import { useState } from "react";
import { cn } from "@/lib/utils";
import { CollectionDialog } from "@/components/collections/CollectionDialog";
import { GlobalSearch } from "@/components/search/GlobalSearch";
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
  children: string;
  disabled?: boolean;
  title?: string;
}

function ItemButton({ active, onClick, children, disabled, title }: ItemButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-current={active ? "true" : undefined}
      className={cn(
        "w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-foreground hover:bg-accent/60",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
    </button>
  );
}

export function Sidebar({ active, onSectionChange }: SidebarProps) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <aside data-testid="sidebar" className="flex w-56 shrink-0 flex-col border-r bg-muted/40 p-4">
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
            <CollectionDialog open={createOpen} onOpenChange={setCreateOpen} />
          </div>
          <p className="mt-2 px-3 text-xs text-muted-foreground">No collections yet</p>
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
