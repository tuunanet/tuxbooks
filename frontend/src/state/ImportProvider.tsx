import { useCallback, useMemo, useState, type ReactNode } from "react";
import { scanLibrary } from "@/lib/tauri";
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
 * Shared import flow state. `scan_library` accepts a directory, so dropped
 * or picked entries are imported one by one; per-path failures (e.g. single
 * files, which the backend cannot import yet) are collected and surfaced
 * honestly instead of being hidden or pretended away.
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

      let imported = 0;
      let updated = 0;
      const collected: ImportFailure[] = [];
      for (const path of targets) {
        try {
          const report = await scanLibrary(path);
          imported += report.imported;
          updated += report.updated;
          collected.push(...report.failed);
        } catch (err) {
          collected.push({ path, error: toMessage(err) });
        }
      }

      await refresh();
      setSummary({ imported, updated });
      setFailures(collected);
      setPhase("done");
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
