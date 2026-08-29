import { useState } from "react";
import { Sidebar, type View } from "./Sidebar";
import { LibraryView } from "../library/LibraryView";

function CollectionsPlaceholder() {
  return (
    <section data-testid="collections-view">
      <h2 className="mb-2 text-2xl font-semibold">Collections</h2>
      <p className="text-muted-foreground">Collections are not implemented yet.</p>
    </section>
  );
}

function ReaderPlaceholder() {
  return (
    <section data-testid="reader-view">
      <h2 className="mb-2 text-2xl font-semibold">Reader</h2>
      <p className="text-muted-foreground">The reading experience is not implemented yet.</p>
    </section>
  );
}

export function AppShell() {
  const [view, setView] = useState<View>("library");

  return (
    <div data-testid="app-shell" className="flex h-screen overflow-hidden">
      <Sidebar active={view} onNavigate={setView} />
      <main className="flex-1 overflow-y-auto p-8">
        {view === "library" && <LibraryView />}
        {view === "collections" && <CollectionsPlaceholder />}
        {view === "reader" && <ReaderPlaceholder />}
      </main>
    </div>
  );
}
