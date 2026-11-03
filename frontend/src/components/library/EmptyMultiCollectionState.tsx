import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyMultiCollectionStateProps {
  onShowAllBooks: () => void;
}

/** A union of collections whose members add up to nothing. */
export function EmptyMultiCollectionState({ onShowAllBooks }: EmptyMultiCollectionStateProps) {
  return (
    <div
      data-testid="empty-multi-collection"
      className="flex h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center"
    >
      <FolderOpen className="h-12 w-12 text-muted-foreground" />
      <h3 className="text-lg font-semibold">No books in these collections</h3>
      <p className="max-w-sm text-sm text-muted-foreground">
        The selected collections have no books yet.
      </p>
      <Button variant="outline" size="sm" onClick={onShowAllBooks}>
        All Books
      </Button>
    </div>
  );
}
