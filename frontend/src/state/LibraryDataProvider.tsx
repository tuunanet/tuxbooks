import { type ReactNode } from "react";
import { LibraryDataContext, useLibraryData } from "@/hooks/useLibrary";

/**
 * Single owner of the fetched library data. Imports call `refresh` on the
 * shared state so the library view and the global search stay in sync.
 */
export function LibraryDataProvider({ children }: { children: ReactNode }) {
  const library = useLibraryData();
  return <LibraryDataContext.Provider value={library}>{children}</LibraryDataContext.Provider>;
}
