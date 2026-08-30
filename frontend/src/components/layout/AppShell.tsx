import { LibraryView } from "@/components/library/LibraryView";
import { DropZoneOverlay } from "@/components/library/DropZoneOverlay";
import { ImportStatus } from "@/components/library/ImportStatus";
import { Button } from "@/components/ui/button";
import { useShortcut } from "@/lib/shortcuts";
import { useAppDispatch, useAppState, type AppState } from "@/state/appState";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { ShortcutProvider } from "@/state/ShortcutProvider";
import { Sidebar } from "./Sidebar";

/** Focuses the global search field once it exists (wired up in the search stage). */
function GlobalSearchShortcut() {
  useShortcut("mod+k", () => {
    document.querySelector<HTMLElement>('[data-shortcut="global-search"]')?.focus();
  });
  return null;
}

function BookDetailPlaceholder() {
  const dispatch = useAppDispatch();
  return (
    <section data-testid="book-detail-placeholder">
      <h2 className="text-2xl font-semibold">Book detail</h2>
      <p className="mt-2 text-muted-foreground">The detail view is not implemented yet.</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-4"
        onClick={() => dispatch({ type: "return-to-library" })}
      >
        Back to Library
      </Button>
    </section>
  );
}

function SettingsPlaceholder() {
  return (
    <section data-testid="settings-view">
      <h2 className="text-2xl font-semibold">Settings</h2>
      <p className="mt-2 text-muted-foreground">Settings are not implemented yet.</p>
    </section>
  );
}

function CollectionsPlaceholder() {
  return (
    <section data-testid="collections-view">
      <h2 className="text-2xl font-semibold">Collections</h2>
      <p className="mt-2 text-muted-foreground">Collections are not implemented yet.</p>
    </section>
  );
}

/**
 * Reader placeholder: the full window, no library sidebar. The ReaderShell
 * replaces this in the reader stage.
 */
function ReaderPlaceholder() {
  const dispatch = useAppDispatch();
  return (
    <div
      data-testid="reader-view"
      className="flex h-screen flex-col items-center justify-center gap-3"
    >
      <h2 className="text-2xl font-semibold">Reader</h2>
      <p className="text-muted-foreground">The reading experience is not implemented yet.</p>
      <Button variant="outline" size="sm" onClick={() => dispatch({ type: "return-to-library" })}>
        Back to Library
      </Button>
    </div>
  );
}

function Shell() {
  const app = useAppState();
  const dispatch = useAppDispatch();

  if (app.view === "reader") {
    return <ReaderPlaceholder />;
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
          <BookDetailPlaceholder />
        ) : app.section.kind === "settings" ? (
          <SettingsPlaceholder />
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
