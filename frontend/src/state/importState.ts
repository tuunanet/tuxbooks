import { createContext, useContext } from "react";

export interface ImportFailure {
  path: string;
  error: string;
}

export interface ImportSummary {
  imported: number;
  updated: number;
  /** Files already in the library whose file had not changed. */
  skipped: number;
  /** Folders the run turned into watched folders, to disclose out loud. */
  watched: string[];
  /**
   * Folders the run declined to register because a watched folder above
   * already covers them. Their books still arrive, so the report says where
   * they came from instead of naming a watch that was never started.
   */
  covered: string[];
  /** The run stopped because its folder was unwatched mid-scan. */
  cancelled: boolean;
}

export type ImportPhase = "idle" | "importing" | "done";

export interface ImportState {
  phase: ImportPhase;
  summary: ImportSummary | null;
  failures: ImportFailure[];
  importPaths: (paths: string[]) => Promise<void>;
  dismiss: () => void;
}

export const ImportContext = createContext<ImportState | null>(null);

export function useImport(): ImportState {
  const importState = useContext(ImportContext);
  if (!importState) {
    throw new Error("useImport must be used within ImportProvider");
  }
  return importState;
}
