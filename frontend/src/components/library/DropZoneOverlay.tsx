import { useEffect, useState } from "react";
import { BookUp } from "lucide-react";
import { pathForFile } from "@/lib/bridge";
import { useImport } from "@/state/importState";

/**
 * Full-window overlay shown while files are dragged over the app. Chromium
 * delivers native drag-and-drop as HTML5 DOM drag events; drops are handed
 * to the shared import flow (folders of EPUBs import, anything else is
 * reported as a failure). The sandboxed preload resolves dropped files to
 * absolute paths (`File.path` no longer exists in Chromium).
 */
export function DropZoneOverlay() {
  const { importPaths } = useImport();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent): void => {
      // Required to keep receiving drop events over the document.
      event.preventDefault();
    };
    const onLeave = (): void => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      void importPaths(files.map(pathForFile));
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
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
