import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { BookUp } from "lucide-react";
import { useImport } from "@/state/importState";

/**
 * Full-window overlay shown while files are dragged over the app. Tauri
 * intercepts native drag-and-drop, so HTML5 DOM drag events must not be used
 * (they never fire). Drops are handed to the shared import flow; folders of
 * EPUBs import, anything else is reported as a failure.
 */
export function DropZoneOverlay() {
  const { importPaths } = useImport();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      switch (event.payload.type) {
        case "enter":
        case "over":
          setDragging(true);
          break;
        case "leave":
          setDragging(false);
          break;
        case "drop":
          setDragging(false);
          void importPaths(event.payload.paths);
          break;
      }
    });

    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, [importPaths]);

  if (!dragging) return null;

  return (
    <div
      data-testid="dropzone-overlay"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-8"
    >
      <div className="flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary/50 text-center">
        <BookUp aria-hidden="true" className="size-12 text-primary/70" />
        <p className="text-lg font-semibold">Drop books to import them</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Folders of EPUB files are scanned and added to your library. Nothing leaves your machine.
        </p>
      </div>
    </div>
  );
}
