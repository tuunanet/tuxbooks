import { FolderOpen } from "lucide-react";

export function EmptyCollectionState() {
  return (
    <div
      data-testid="empty-collection"
      className="flex h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center"
    >
      <FolderOpen className="h-12 w-12 text-muted-foreground" />
      <h3 className="text-lg font-semibold">This collection is empty</h3>
      <p className="max-w-sm text-sm text-muted-foreground">
        Right-click a book and choose “Add to Collection” to file it here.
      </p>
    </div>
  );
}
