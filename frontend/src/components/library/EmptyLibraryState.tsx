import { BookOpen, Import } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pickDirectory } from "@/lib/tauri";
import { useImport } from "@/state/importState";

export function EmptyLibraryState() {
  const { importPaths } = useImport();

  const importFolder = async () => {
    const dir = await pickDirectory();
    if (dir) await importPaths([dir]);
  };

  return (
    <div
      data-testid="empty-library"
      className="flex h-full flex-col items-center justify-center gap-3 text-center"
    >
      <BookOpen aria-hidden="true" className="h-12 w-12 text-muted-foreground" />
      <h2 className="text-xl font-semibold">Your library is empty</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Point tuxbooks at a folder of EPUB files to import your books. Books are read from disk and
        indexed locally — nothing leaves your machine.
      </p>
      <Button data-testid="empty-library-import" size="sm" onClick={() => void importFolder()}>
        <Import data-icon="inline-start" />
        Import Folder…
      </Button>
    </div>
  );
}
