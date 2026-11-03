import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CollectionRef } from "@/lib/collectionPreferences";
import type { CollectionSummary } from "@/types/domain";

export interface CollectionSaveResult {
  ok: boolean;
  error?: string;
  collection?: CollectionSummary;
}

interface CollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Performs the backend save; returns the outcome (or an error message). */
  onSubmit: (name: string) => Promise<CollectionSaveResult>;
  /** Set to edit this collection; omit to create a new one. */
  collection?: CollectionRef | null;
  trigger?: boolean;
}

/**
 * Collection dialog (milestone 10): creates a collection, or renames one
 * when `collection` is set. Saves through the sidebar's collection actions
 * and surfaces backend rejections (blank or duplicate names) inline instead
 * of faking a save.
 */
export function CollectionDialog({
  open,
  onOpenChange,
  onSubmit,
  collection,
  trigger = true,
}: CollectionDialogProps) {
  const renaming = collection != null;
  const [name, setName] = useState(collection?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    const result = await onSubmit(name);
    setSaving(false);
    if (result.ok) {
      setName("");
      onOpenChange(false);
    } else {
      setError(result.error ?? `Could not ${renaming ? "rename" : "create"} the collection`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && (
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            data-testid="new-collection-button"
            className="w-full justify-start px-3 text-muted-foreground"
          >
            <Plus data-icon="inline-start" />
            New Collection
          </Button>
        </DialogTrigger>
      )}
      <DialogContent data-testid="collection-dialog" className="sm:max-w-sm">
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{renaming ? "Rename Collection" : "New Collection"}</DialogTitle>
            <DialogDescription>
              {renaming
                ? `Rename ${collection.name}. Books stay in the library; a collection is only a view over them.`
                : "Group books into named collections. Books stay in the library; a collection is only a view over them."}
            </DialogDescription>
          </DialogHeader>
          <Input
            data-testid="collection-name"
            aria-label="Collection name"
            placeholder="Collection name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
          {error && (
            <p role="alert" data-testid="collection-error" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              data-testid={renaming ? "collection-rename" : "collection-create"}
              disabled={name.trim() === "" || saving}
            >
              {renaming ? "Rename" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
