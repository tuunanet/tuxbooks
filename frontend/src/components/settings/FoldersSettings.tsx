import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { UnwatchFoldersDialog, type UnwatchPlan } from "@/components/settings/UnwatchFoldersDialog";
import {
  getStorageReport,
  pickDirectory,
  unwatchLocations,
  type StorageReport,
} from "@/lib/bridge";
import { formatMb } from "@/lib/format";
import { useImport } from "@/state/importState";

type FolderRow = StorageReport["bookLocations"][number];

/**
 * The separator-split ancestry rule the library runs on (`owning_location`
 * in the sidecar): a folder is under a root when it *is* the root or
 * continues under it after a '/'. A shared string prefix is not ancestry —
 * `/libx` is not under `/lib`.
 */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Books owned by any folder at or under `roots`; ownership is per location. */
function booksIn(locations: FolderRow[], roots: string[]): number {
  return locations
    .filter((location) => roots.some((root) => isUnder(location.path, root)))
    .reduce((total, location) => total + location.bookCount, 0);
}

/**
 * What the selection implies, read off the watch list alone (ADR 0010).
 * A selected folder under a folder that stays watched is refused by the
 * sidecar, so the plan offers the only move that holds: take the watched
 * folder above it, and everything that comes with it. Folders *inside* a
 * selected folder are a plain choice, because keeping them watched is a
 * state the library can express.
 */
function planUnwatch(locations: FolderRow[], chosen: FolderRow[]): UnwatchPlan {
  const chosenPaths = new Set(chosen.map((folder) => folder.path));
  const staying = locations.filter((location) => !chosenPaths.has(location.path));

  // The shallowest watched folder above a selected one — the folder whose
  // recursive watch covers the selected folder's files.
  const ancestors = new Map<string, string>();
  for (const folder of chosen) {
    const above = staying
      .map((location) => location.path)
      .filter((root) => root !== folder.path && isUnder(folder.path, root))
      .sort((a, b) => a.length - b.length)[0];
    if (above) ancestors.set(folder.path, above);
  }

  if (ancestors.size > 0) {
    const roots = [...new Set(ancestors.values())];
    const inside = staying.filter((location) => roots.some((root) => isUnder(location.path, root)));
    return {
      kind: "steer",
      ancestors: roots,
      extraFolders: inside.length,
      extraBooks:
        booksIn(locations, [...chosenPaths, ...roots]) - booksIn(locations, [...chosenPaths]),
    };
  }

  const nested = staying.filter((location) =>
    chosen.some((folder) => isUnder(location.path, folder.path)),
  );
  if (nested.length > 0) {
    return { kind: "ask", inside: nested.map((location) => location.path), cascade: false };
  }
  return { kind: "plain" };
}

/** The folders this unwatch removes: the selection plus whatever the plan adds. */
function foldersRemoved(
  locations: FolderRow[],
  chosen: FolderRow[],
  plan: UnwatchPlan,
): FolderRow[] {
  if (plan.kind === "ask" && plan.cascade) {
    const roots = [...chosen.map((folder) => folder.path), ...plan.inside];
    return locations.filter((location) => roots.some((root) => isUnder(location.path, root)));
  }
  if (plan.kind === "steer") {
    const roots = [...chosen.map((folder) => folder.path), ...plan.ancestors];
    return locations.filter((location) => roots.some((root) => isUnder(location.path, root)));
  }
  return chosen;
}

/**
 * The Folders tab: every folder TuxBooks watches, with its book count and
 * total size, and a label on the rows whose path is gone from disk so dead
 * entries stay visible. Rows carry checkboxes and one toolbar Unwatch acts
 * on the whole selection. Add folder runs the same import flow the header
 * menu uses, so a folder added here is watched exactly like one imported
 * from there.
 */
export function FoldersSettings() {
  const { importPaths } = useImport();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [unwatching, setUnwatching] = useState(false);
  const [plan, setPlan] = useState<UnwatchPlan>({ kind: "plain" });

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

  const locations = useMemo(() => report?.bookLocations ?? [], [report]);
  const chosen = useMemo(
    () => locations.filter((location) => selected.has(location.id)),
    [locations, selected],
  );
  const allSelected = locations.length > 0 && chosen.length === locations.length;

  const toggle = useCallback((id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    // `allSelected` and `locations` already answer "everything or nothing";
    // re-reading the report here would be a second source of the same rule.
    setSelected(allSelected ? new Set<number>() : new Set(locations.map((row) => row.id)));
  }, [allSelected, locations]);

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

  const confirmUnwatch = useCallback(async () => {
    // The plan is the whole truth about scope: a steer takes the watched
    // folder above the selection and everything in it, a cascade takes the
    // folders inside, and anything else removes exactly what was selected.
    const cascade = plan.kind === "steer" || (plan.kind === "ask" && plan.cascade);
    const paths =
      plan.kind === "steer"
        ? [...chosen.map((location) => location.path), ...plan.ancestors]
        : chosen.map((location) => location.path);

    setUnwatching(true);
    let unwatched = false;
    try {
      await unwatchLocations(paths, cascade);
      unwatched = true;
    } catch (error) {
      console.error("unwatch_locations failed:", error);
    } finally {
      setUnwatching(false);
    }
    // A failed unwatch keeps the dialog open: the selection is still there
    // to retry or cancel instead of closing over nothing that happened.
    if (!unwatched) return;
    setSelected(new Set());
    setConfirming(false);
    await load();
  }, [chosen, load, plan]);

  return (
    <div data-testid="settings-rows" className="mt-6 flex flex-col gap-6">
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium">
            Watched folders
            {locations.length > 0 ? ` (${locations.length})` : ""}
          </p>
          <div className="flex items-center gap-2">
            {chosen.length > 0 && (
              <Button
                data-testid="folders-clear"
                variant="ghost"
                size="sm"
                disabled={unwatching}
                onClick={() => setSelected(new Set())}
              >
                Cancel
              </Button>
            )}
            <Button
              data-testid="folders-unwatch"
              variant="destructive"
              size="sm"
              disabled={chosen.length === 0 || unwatching}
              onClick={() => {
                setPlan(planUnwatch(locations, chosen));
                setConfirming(true);
              }}
            >
              Unwatch
            </Button>
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
        </div>

        {failed ? (
          <p data-testid="folders-failed" className="mt-3 text-sm text-muted-foreground">
            Could not read the folder list.
          </p>
        ) : !report ? (
          <p data-testid="folders-loading" className="mt-3 text-sm text-muted-foreground">
            Reading folders...
          </p>
        ) : locations.length === 0 ? (
          <p data-testid="folders-empty" className="mt-3 text-xs text-muted-foreground">
            No folders have been added yet. Import a folder to build your library.
          </p>
        ) : (
          <div className="mt-3">
            <label className="flex items-center gap-2 border-b py-2">
              <Checkbox
                data-testid="folders-select-all"
                checked={allSelected}
                disabled={unwatching}
                onCheckedChange={() => toggleAll()}
              />
              <span className="text-xs text-muted-foreground">Select all</span>
            </label>
            <ul data-testid="folders-list" className="max-h-96 divide-y overflow-y-auto">
              {locations.map((location) => (
                <li key={location.id} data-testid={`folder-row-${location.id}`} className="py-2">
                  <label className="flex items-start gap-2">
                    <Checkbox
                      data-testid={`folder-select-${location.id}`}
                      aria-label={`Select ${location.path}`}
                      checked={selected.has(location.id)}
                      disabled={unwatching}
                      onCheckedChange={() => toggle(location.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <code
                        title={location.path}
                        className="block truncate text-xs text-muted-foreground"
                      >
                        {location.path}
                      </code>
                      <span className="mt-0.5 flex items-center gap-2">
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
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <UnwatchFoldersDialog
        open={confirming}
        folders={foldersRemoved(locations, chosen, plan)}
        plan={plan}
        onPlanChange={setPlan}
        busy={unwatching}
        onConfirm={() => void confirmUnwatch()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
