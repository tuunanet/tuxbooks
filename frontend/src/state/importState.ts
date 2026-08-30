import { createContext, useContext } from "react";

export interface ImportFailure {
  path: string;
  error: string;
}

export interface ImportSummary {
  imported: number;
  updated: number;
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
