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

/** The plan before Unwatch is clicked: the dialog is closed, nothing runs. */
const IDLE_PLAN: UnwatchPlan = {
  kind: "plain",
  ancestors: [],
  inside: [],
  spared: [],
  cascade: false,
  folders: [],
  paths: [],
  extraFolders: 0,
  extraBooks: 0,
};

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

function planUnwatch(locations: FolderRow[], chosen: FolderRow[], cascade = false): UnwatchPlan {
  const chosenPaths = chosen.map((folder) => folder.path);
  const chosenSet = new Set(chosenPaths);
  const staying = locations.filter((location) => !chosenSet.has(location.path));

  // The shallowest watched folder above a selected one, which is the folder
  // whose recursive watch covers the selected folder's files and the one the
  // sidecar names in its refusal.
  const ancestors = new Set<string>();
  for (const folder of chosen) {
    const above = staying
      .map((location) => location.path)
      .filter((root) => root !== folder.path && isUnder(folder.path, root))
      .sort((a, b) => a.length - b.length)[0];
    if (above) ancestors.add(above);
  }

  const inside = staying
    .filter((location) => chosenPaths.some((root) => isUnder(location.path, root)))
    .map((location) => location.path);

  // What the plan adds to the selection: the folders above it, or the ones
  // inside it. Expanding the folder list by subtree is what a steer or a
  // cascade does; without one, the folders are exactly the ones ticked.
  const added = (kind: UnwatchPlan["kind"], cascade: boolean): string[] => {
    if (kind === "steer") return [...ancestors];
    return cascade ? inside : [];
  };

  const plan = (kind: UnwatchPlan["kind"], cascade: boolean): UnwatchPlan => {
    const roots = [...chosenPaths, ...added(kind, cascade)];
    // A cascade expands to the whole subtree. A steer does not: it takes the
    // folder above and the ones ticked, because a watched folder beside them
    // keeps its own watch when its parent leaves the list.
    const folders = cascade
      ? locations.filter((location) => roots.some((root) => isUnder(location.path, root)))
      : locations.filter((location) => roots.includes(location.path));
    return {
      kind,
      ancestors: [...ancestors],
      inside,
      spared: staying
        .filter(
          (location) =>
            !roots.includes(location.path) &&
            [...ancestors].some((ancestor) => isUnder(location.path, ancestor)),
        )
        .map((location) => location.path),
      cascade,
      folders,
      paths: kind === "steer" ? [...chosenPaths, ...ancestors] : chosenPaths,
      extraFolders: 0,
      extraBooks: 0,
    };
  };

  if (ancestors.size > 0) {
    // No cascade here on purpose: the folder above and the ones ticked are
    // enough to close the hole, and a sibling keeps its own watch.
    const kept = plan("steer", false);
    const booksOf = (rows: FolderRow[]) => rows.reduce((total, row) => total + row.bookCount, 0);
    return {
      ...kept,
      extraFolders: kept.folders.length - chosen.length,
      extraBooks: booksOf(kept.folders) - booksOf(chosen),
    };
  }
  if (inside.length > 0) return plan("ask", cascade);
  return plan("plain", false);
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
  const [plan, setPlan] = useState<UnwatchPlan>(IDLE_PLAN);

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

  // Toggling the cascade changes what gets removed, so the plan is rebuilt
  // from the watch list rather than patched: the dialog's book count is a
  // promise about the operation, and it has to follow the choice.
  const changePlan = useCallback(
    (next: UnwatchPlan) => {
      setPlan(
        next.kind === "ask" && next.cascade !== plan.cascade
          ? planUnwatch(locations, chosen, next.cascade)
          : next,
      );
    },
    [chosen, locations, plan],
  );

  const confirmUnwatch = useCallback(async () => {
    setUnwatching(true);
    let unwatched = false;
    try {
      await unwatchLocations(plan.paths, plan.cascade);
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
  }, [load, plan]);

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
        plan={plan}
        onPlanChange={changePlan}
        busy={unwatching}
        onConfirm={() => void confirmUnwatch()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
