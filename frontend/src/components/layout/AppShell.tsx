import { useEffect } from "react";
import { BookDetail } from "@/components/books/BookDetail";
import { LibraryView } from "@/components/library/LibraryView";
import { DropZoneOverlay } from "@/components/library/DropZoneOverlay";
import { ImportStatus } from "@/components/library/ImportStatus";
import { ReaderShell } from "@/components/reader/ReaderShell";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { prewarmPdfEngine } from "@/lib/pdf/pdfEngine";
import { useShortcut } from "@/lib/shortcuts";
import { useAppDispatch, useAppState, type AppState } from "@/state/appState";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { ReaderProvider } from "@/state/ReaderProvider";
import { ShortcutProvider } from "@/state/ShortcutProvider";
import { useThemeState } from "@/state/themeState";
import { Sidebar } from "./Sidebar";

/** Focuses the global search field once it exists (wired up in the search stage). */
function GlobalSearchShortcut() {
  useShortcut("mod+k", () => {
    document.querySelector<HTMLElement>('[data-shortcut="global-search"]')?.focus();
  });
  return null;
}

/**
 * PDF engine prewarm (§ warm engine): once the shell has rendered and the
 * main thread goes idle, load the PDFium module into a spare worker so the
 * first PDF open skips worker startup + WASM fetch/compile. Never opens a
 * document or rasterizes; a failed prewarm only means the next open pays
 * the cold start. Deliberately NOT cancelled on unmount — the reader view
 * replaces this shell exactly when a prewarmed worker is most valuable.
 */
function PdfEnginePrewarm() {
  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(
        () => {
          void prewarmPdfEngine().catch(() => {
            // Diagnostics only; the open path falls back to a cold worker.
          });
        },
        { timeout: 3000 },
      );
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(() => {
      void prewarmPdfEngine().catch(() => {});
    }, 1500);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}

/**
 * Reader: the full window, no library sidebar. Own providers — reader state
 * is session-scoped and the toolbar introduces the app's first tooltips.
 * The reader surface follows the global theme until a theme is picked in
 * the appearance menu (ReaderProvider pins it from then on).
 */
function Reader() {
  const { resolvedTheme } = useThemeState();
  return (
    <ReaderProvider globalTheme={resolvedTheme}>
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
          <SettingsShell
            onSelectSection={(section) => dispatch({ type: "select-section", section })}
          />
        ) : (
          /* Smart and collection sections share the library view; collection
             filtering happens inside (milestone 10). */
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
        <PdfEnginePrewarm />
        <LibraryDataProvider>
          <ImportProvider>
            <Shell />
          </ImportProvider>
        </LibraryDataProvider>
      </ShortcutProvider>
    </AppStateProvider>
  );
}
