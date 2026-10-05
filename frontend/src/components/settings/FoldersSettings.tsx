import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { getStorageReport, pickDirectory, type StorageReport } from "@/lib/bridge";
import { formatMb } from "@/lib/format";
import { useImport } from "@/state/importState";

/**
 * The Folders tab: every folder TuxBooks watches, with its book count and
 * total size, and a label on the rows whose path is gone from disk so dead
 * entries stay visible. Rows are display-only; Add folder runs the same
 * import flow the header menu uses, so a folder added here is watched
 * exactly like one imported from there.
 */
export function FoldersSettings() {
  const { importPaths } = useImport();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(
    () =>
      getStorageReport().then(
        (next) => {
          setReport(next);
          setFailed(false);
        },
        () => {
          setFailed(true);
        },
      ),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const addFolder = useCallback(async () => {
    setAdding(true);
    try {
      const dir = await pickDirectory();
      if (dir) {
        await importPaths([dir]);
        await load();
      }
    } finally {
      setAdding(false);
    }
  }, [importPaths, load]);

  return (
    <div data-testid="settings-rows" className="mt-6 flex flex-col gap-6">
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium">
            Watched folders
            {report && report.bookLocations.length > 0 ? ` (${report.bookLocations.length})` : ""}
          </p>
          <Button
            data-testid="folders-add"
            variant="outline"
            size="sm"
            disabled={adding}
            onClick={() => void addFolder()}
          >
            Add folder
          </Button>
        </div>

        {failed ? (
          <p data-testid="folders-failed" className="mt-3 text-sm text-muted-foreground">
            Could not read the folder list.
          </p>
        ) : !report ? (
          <p data-testid="folders-loading" className="mt-3 text-sm text-muted-foreground">
            Reading folders...
          </p>
        ) : report.bookLocations.length === 0 ? (
          <p data-testid="folders-empty" className="mt-3 text-xs text-muted-foreground">
            No folders have been added yet. Import a folder to build your library.
          </p>
        ) : (
          <ul data-testid="folders-list" className="mt-3 max-h-96 divide-y overflow-y-auto">
            {report.bookLocations.map((location) => (
              <li key={location.id} data-testid={`folder-row-${location.id}`} className="py-2">
                <code
                  title={location.path}
                  className="block truncate text-xs text-muted-foreground"
                >
                  {location.path}
                </code>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {location.bookCount} {location.bookCount === 1 ? "book" : "books"} ·{" "}
                    {formatMb(location.totalBytes)}
                  </span>
                  {location.missingFromDisk && (
                    <span
                      data-testid={`folder-missing-${location.id}`}
                      className="text-xs font-medium text-destructive"
                    >
                      Missing from disk
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
