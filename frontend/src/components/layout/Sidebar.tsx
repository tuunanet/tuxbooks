import {
  BookMarked,
  BookOpen,
  CheckCircle2,
  Clock3,
  Library,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { SidebarCollections } from "@/components/layout/SidebarCollections";
import { GroupLabel, ItemButton, ItemLabel } from "@/components/layout/SidebarItems";
import { GlobalSearch } from "@/components/search/GlobalSearch";
import {
  sameSection,
  type CollectionSelectMode,
  type LibrarySection,
  type SmartSectionId,
} from "@/state/appState";
import { useSyncAttention } from "@/state/syncAttentionState";

interface SidebarProps {
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
  onOpenSettings: () => void;
}

const LIBRARY_ITEMS: { id: SmartSectionId; label: string; icon: LucideIcon }[] = [
  { id: "all-books", label: "All Books", icon: Library },
  { id: "recently-added", label: "Recently Added", icon: Clock3 },
  { id: "recently-read", label: "Recently Read", icon: BookOpen },
  { id: "in-progress", label: "In Progress", icon: BookMarked },
  { id: "finished", label: "Finished", icon: CheckCircle2 },
];

export function Sidebar({
  active,
  onSectionChange,
  onCollectionSelect,
  onCollectionDeleted,
  onOpenSettings,
}: SidebarProps) {
  const { attention: syncNeedsAttention } = useSyncAttention();

  return (
    <aside
      data-testid="sidebar"
      aria-label="Library sidebar"
      className="flex w-72 min-w-72 shrink-0 flex-col border-r bg-muted/40 p-4"
    >
      <div className="mb-5 px-3">
        <h1 className="text-lg font-semibold">TuxBooks</h1>
        <p className="text-xs text-muted-foreground">Your personal ebook library</p>
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
                  <ItemLabel icon={item.icon}>{item.label}</ItemLabel>
                </ItemButton>
              );
            })}
          </div>
        </div>

        <SidebarCollections
          active={active}
          onSectionChange={onSectionChange}
          onCollectionSelect={onCollectionSelect}
          onCollectionDeleted={onCollectionDeleted}
        />
      </nav>

      <div className="mt-4 border-t pt-3">
        <ItemButton
          active={false}
          testId="sidebar-settings"
          ariaHaspopup="dialog"
          onClick={onOpenSettings}
        >
          <ItemLabel icon={Settings}>Settings</ItemLabel>
          {syncNeedsAttention ? (
            <>
              <span
                data-testid="settings-attention-dot"
                aria-hidden="true"
                className="ml-auto size-2 shrink-0 rounded-full bg-destructive"
              />
              <span className="sr-only">Sync needs attention</span>
            </>
          ) : null}
        </ItemButton>
      </div>
    </aside>
  );
}
