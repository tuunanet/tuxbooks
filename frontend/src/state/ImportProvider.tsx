import { useCallback, useMemo, useState, type ReactNode } from "react";
import { importPaths as importPathsCommand } from "@/lib/tauri";
import { useLibrary } from "@/hooks/useLibrary";
import {
  ImportContext,
  type ImportFailure,
  type ImportPhase,
  type ImportSummary,
} from "./importState";

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shared import flow state (milestone 10). The `import_paths` command accepts
 * a mixed batch of files and folders — folders become watched locations,
 * files import in place — so picked and dropped entries go through one
 * call; per-path failures are surfaced honestly instead of being hidden.
 */
export function ImportProvider({ children }: { children: ReactNode }) {
  const { refresh } = useLibrary();
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [failures, setFailures] = useState<ImportFailure[]>([]);

  const importPaths = useCallback(
    async (paths: string[]) => {
      const targets = paths.filter((path) => path.trim() !== "");
      if (targets.length === 0) return;

      setPhase("importing");
      setSummary(null);
      setFailures([]);

      try {
        const report = await importPathsCommand(targets);
        await refresh();
        setSummary({ imported: report.imported, updated: report.updated });
        setFailures(report.failed);
        setPhase("done");
      } catch (err) {
        setFailures(targets.map((path) => ({ path, error: toMessage(err) })));
        setSummary({ imported: 0, updated: 0 });
        setPhase("done");
      }
    },
    [refresh],
  );

  const dismiss = useCallback(() => {
    setPhase("idle");
    setSummary(null);
    setFailures([]);
  }, []);

  const value = useMemo(
    () => ({ phase, summary, failures, importPaths, dismiss }),
    [phase, summary, failures, importPaths, dismiss],
  );

  return <ImportContext.Provider value={value}>{children}</ImportContext.Provider>;
}
