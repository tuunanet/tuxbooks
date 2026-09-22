import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  clearCache,
  getStorageReport,
  openDataFolder,
  openLibraryLocation,
  type StorageEntryKind,
  type StorageReport,
  type StorageRootId,
} from "@/lib/bridge";

const KIND_LABEL: Record<StorageEntryKind, string> = {
  derived: "Derived",
  "only-copy": "Only copy",
  settings: "Settings",
};

const CATALOG_ROWS = [
  ["books", "Books"],
  ["authors", "Authors"],
  ["collections", "Collections"],
  ["annotations", "Annotations"],
  ["readingProgress", "Reading progress"],
] as const;

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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);

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

  const confirmClear = useCallback(async () => {
    setClearing(true);
    try {
      const bytes = await clearCache();
      setFreed(bytes);
      setConfirmOpen(false);
      setReport(await getStorageReport());
    } catch {
      setConfirmOpen(false);
    } finally {
      setClearing(false);
    }
  }, []);

  const open = useCallback((rootId: StorageRootId) => {
    void openDataFolder(rootId).catch(() => {});
  }, []);

  const openLocation = useCallback((locationId: number) => {
    void openLibraryLocation(locationId).catch(() => {});
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
          TuxBooks app data: {formatMb(report.appDataBytes)} · Your book files:{" "}
          {formatMb(report.bookTotalBytes)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Book files are counted where they live, not as app data. Some browser cache rebuilds while
          the app runs, so the app data size can change between visits.
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
          {root.id === "app-config" && (
            <p data-testid="storage-settings-hint" className="mt-3 text-xs text-muted-foreground">
              Includes your theme and reader settings. A full app data wipe would clear them.
            </p>
          )}
        </div>
      ))}

      <div data-testid="storage-clear-cache" className="rounded-lg border p-4">
        <p className="text-sm font-medium">Clear cache</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Frees the browser caches and the GPU fallback marker, the data TuxBooks rebuilds by
          itself. Your catalog, cover cache, settings, and books stay.
        </p>
        <Button
          data-testid="clear-cache-button"
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={report.cacheBytes === 0}
          onClick={() => {
            setFreed(null);
            setConfirmOpen(true);
          }}
        >
          Clear cache ({formatMb(report.cacheBytes)})
        </Button>
        {freed !== null && (
          <p
            data-testid="storage-clear-result"
            role="status"
            className="mt-2 text-xs text-muted-foreground"
          >
            Freed {formatMb(freed)}. Some browser cache is rewritten while the app runs, so freed
            space can read larger after a restart.
          </p>
        )}
      </div>

      <div data-testid="storage-book-locations" className="rounded-lg border p-4">
        <p className="text-sm font-medium">Book folders</p>
        {report.bookLocations.length === 0 ? (
          <p
            data-testid="storage-book-locations-empty"
            className="mt-1 text-xs text-muted-foreground"
          >
            No folders have been added yet. Import a folder to build your library.
          </p>
        ) : (
          <ul className="mt-4 divide-y">
            {report.bookLocations.map((location) => (
              <li
                key={location.id}
                data-testid={`storage-location-${location.id}`}
                className="flex items-center justify-between gap-4 py-2"
              >
                <div className="min-w-0">
                  <code
                    title={location.path}
                    className="block truncate text-xs text-muted-foreground"
                  >
                    {location.path}
                  </code>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {location.bookCount} {location.bookCount === 1 ? "book" : "books"} ·{" "}
                    {formatMb(location.totalBytes)}
                  </span>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" onClick={() => openLocation(location.id)}>
                    Open folder
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => copyPath(location.path)}>
                    Copy path
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div data-testid="storage-catalog" className="rounded-lg border p-4">
        <p className="text-sm font-medium">Catalog</p>
        <ul className="mt-4 divide-y">
          {CATALOG_ROWS.map(([key, label]) => (
            <li
              key={key}
              data-testid={`storage-catalog-${key}`}
              className="flex items-center justify-between gap-4 py-2"
            >
              <span className="text-sm">{label}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {report.catalog[key]}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p data-testid="storage-reassurance" className="text-xs text-muted-foreground">
        Your books are read in place and never copied into the app.
      </p>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent data-testid="clear-cache-dialog" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear cache?</DialogTitle>
            <DialogDescription>
              Removes the browser caches and the GPU fallback marker. Keeps your catalog, cover
              cache, settings, and books. Some browser cache is rewritten while the app runs, so
              freed space can read larger after a restart.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="clear-cache-cancel"
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="clear-cache-confirm"
              disabled={clearing}
              onClick={() => void confirmClear()}
            >
              Yes, clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
