import { BookDetail } from "@/components/books/BookDetail";
import { LibraryView } from "@/components/library/LibraryView";
import { DropZoneOverlay } from "@/components/library/DropZoneOverlay";
import { ImportStatus } from "@/components/library/ImportStatus";
import { ReaderShell } from "@/components/reader/ReaderShell";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useShortcut } from "@/lib/shortcuts";
import { useAppDispatch, useAppState, type AppState } from "@/state/appState";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { ReaderProvider } from "@/state/ReaderProvider";
import { ShortcutProvider } from "@/state/ShortcutProvider";
import { Sidebar } from "./Sidebar";

/** Focuses the global search field once it exists (wired up in the search stage). */
function GlobalSearchShortcut() {
  useShortcut("mod+k", () => {
    document.querySelector<HTMLElement>('[data-shortcut="global-search"]')?.focus();
  });
  return null;
}

function CollectionsPlaceholder() {
  return (
    <section data-testid="collections-view">
      <h2 className="text-2xl font-semibold">Collections</h2>
      <p className="mt-2 text-muted-foreground">
        Collections are not connected to the backend yet — create one from the sidebar once import
        support lands.
      </p>
    </section>
  );
}

/**
 * Reader: the full window, no library sidebar. Own providers — reader state
 * is session-scoped and the toolbar introduces the app's first tooltips.
 */
function Reader() {
  return (
    <ReaderProvider>
      <TooltipProvider delayDuration={200}>
        <ReaderShell />
      </TooltipProvider>
    </ReaderProvider>
  );
}

function Shell() {
  const app = useAppState();
  const dispatch = useAppDispatch();

  if (app.view === "reader") {
    return <Reader />;
  }

  return (
    <div data-testid="app-shell" className="flex h-screen overflow-hidden">
      <Sidebar
        active={app.section}
        onSectionChange={(section) => dispatch({ type: "select-section", section })}
      />
      <main className="relative flex-1 overflow-y-auto p-8">
        <ImportStatus />
        {app.view === "detail" ? (
          <BookDetail />
        ) : app.section.kind === "settings" ? (
          <SettingsShell />
        ) : app.section.kind === "collection" ? (
          <CollectionsPlaceholder />
        ) : (
          <LibraryView section={app.section} />
        )}
      </main>
      <DropZoneOverlay />
    </div>
  );
}

export interface AppShellProps {
  /** Optional override for tests and previews; defaults to the real initial state. */
  initialState?: AppState;
}

export function AppShell({ initialState }: AppShellProps) {
  return (
    <AppStateProvider initialState={initialState}>
      <ShortcutProvider>
        <GlobalSearchShortcut />
        <LibraryDataProvider>
          <ImportProvider>
            <Shell />
          </ImportProvider>
        </LibraryDataProvider>
      </ShortcutProvider>
    </AppStateProvider>
  );
}
