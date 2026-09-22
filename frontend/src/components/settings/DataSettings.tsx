import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  getStorageReport,
  openDataFolder,
  type StorageEntryKind,
  type StorageReport,
  type StorageRootId,
} from "@/lib/bridge";

const KIND_LABEL: Record<StorageEntryKind, string> = {
  derived: "Derived",
  "only-copy": "Only copy",
  settings: "Settings",
  books: "Books",
};

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The Data tab (data-management spec): where TuxBooks keeps its own data and
 * how large it is. Main resolves every path; the renderer displays the report
 * and acts on rows by stable id, never by a path it supplies.
 */
export function DataSettings() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getStorageReport().then(
      (next) => {
        if (active) setReport(next);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const open = useCallback((rootId: StorageRootId) => {
    void openDataFolder(rootId).catch(() => {});
  }, []);

  const copyPath = useCallback((pathValue: string) => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(pathValue).catch(() => {});
  }, []);

  if (failed) {
    return (
      <p data-testid="settings-rows" className="mt-6 text-sm text-muted-foreground">
        Could not read the storage report.
      </p>
    );
  }

  if (!report) {
    return (
      <p data-testid="settings-rows" className="mt-6 text-sm text-muted-foreground">
        Reading storage...
      </p>
    );
  }

  return (
    <div data-testid="settings-rows" className="mt-6 flex flex-col gap-6">
      <div className="rounded-lg border p-4">
        <p data-testid="storage-total" className="text-sm font-medium">
          Total app footprint: {formatMb(report.appDataBytes)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Some browser cache rebuilds while the app runs, so the numbers can change between visits.
        </p>
      </div>

      {report.roots.map((root) => (
        <div
          key={root.id}
          data-testid={`storage-root-${root.id}`}
          className="rounded-lg border p-4"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">{root.label}</p>
              <code
                data-testid={`storage-path-${root.id}`}
                title={root.path}
                className="mt-0.5 block truncate text-xs text-muted-foreground"
              >
                {root.path}
              </code>
              <p className="mt-1 text-xs text-muted-foreground">{formatMb(root.sizeBytes)}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={() => open(root.id)}>
                Open folder
              </Button>
              <Button variant="outline" size="sm" onClick={() => copyPath(root.path)}>
                Copy path
              </Button>
            </div>
          </div>
          <ul className="mt-4 divide-y">
            {root.entries.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-4 py-2">
                <span className="text-sm">{entry.label}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{KIND_LABEL[entry.kind]}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatMb(entry.sizeBytes)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <p data-testid="storage-reassurance" className="text-xs text-muted-foreground">
        Your books are read in place and never copied into the app.
      </p>
    </div>
  );
}
