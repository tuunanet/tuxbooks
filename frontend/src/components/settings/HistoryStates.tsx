import { BookMarked } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

/** The detached records tab's empty state: no records, or no search hits. */
export function EmptyDetachedRecords({ searching }: { searching: boolean }) {
  return (
    <div
      data-testid="history-empty"
      className="flex h-64 flex-col items-center justify-center gap-3 text-center"
    >
      <BookMarked aria-hidden="true" className="h-12 w-12 text-muted-foreground" />
      <h3 className="text-lg font-semibold">
        {searching ? "No books match that search" : "No detached records"}
      </h3>
      <p className="max-w-md text-sm text-muted-foreground">
        {searching
          ? "Detached records only cover books whose file is no longer in a watched folder."
          : "When a book leaves your watched folders, TuxBooks keeps its progress, annotations, collections, and metadata here. Relink a file and the book returns to the library with that reading history intact."}
      </p>
    </div>
  );
}

/** The detached records list's loading rows. */
export function HistorySkeleton() {
  return (
    <div data-testid="history-loading" role="status" aria-label="Loading history">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 rounded-lg border p-3">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-20 w-14 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}
