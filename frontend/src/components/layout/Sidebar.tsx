import { cn } from "../../lib/utils";

export type View = "library" | "collections" | "reader";

interface SidebarProps {
  active: View;
  onNavigate: (view: View) => void;
}

const NAV_ITEMS: { view: View; label: string; disabled?: boolean }[] = [
  { view: "library", label: "Library" },
  { view: "collections", label: "Collections" },
  { view: "reader", label: "Reader", disabled: true },
];

export function Sidebar({ active, onNavigate }: SidebarProps) {
  return (
    <aside
      data-testid="sidebar"
      className="flex w-56 shrink-0 flex-col border-r bg-muted/40 p-4"
    >
      <div className="mb-6 px-2">
        <h1 className="text-lg font-semibold">tuxbooks</h1>
        <p className="text-xs text-muted-foreground">Local ebook library</p>
      </div>
      <nav className="flex flex-col gap-1" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            type="button"
            disabled={item.disabled}
            onClick={() => onNavigate(item.view)}
            aria-current={active === item.view ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-2 text-left text-sm font-medium transition-colors",
              active === item.view
                ? "bg-primary text-primary-foreground"
                : "text-foreground hover:bg-accent",
              item.disabled && "opacity-40",
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
