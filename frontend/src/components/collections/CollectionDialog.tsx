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
import type { CollectionSummary } from "@/types/domain";

export interface CreateResult {
  ok: boolean;
  error?: string;
  collection?: CollectionSummary;
}

interface CollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Performs the backend creation; returns the outcome (or an error message). */
  onCreate: (name: string) => Promise<CreateResult>;
  trigger?: boolean;
}

/**
 * Create-collection dialog (milestone 10): saves through the
 * `create_collection` command via the sidebar's collection actions and
 * surfaces backend rejections (blank or duplicate names) inline instead of
 * faking a save.
 */
export function CollectionDialog({
  open,
  onOpenChange,
  onCreate,
  trigger = true,
}: CollectionDialogProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    const result = await onCreate(name);
    setSaving(false);
    if (result.ok) {
      setName("");
      onOpenChange(false);
    } else {
      setError(result.error ?? "Could not create the collection");
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
            <DialogTitle>New Collection</DialogTitle>
            <DialogDescription>
              Group books into named collections. Books stay in the library; a collection is only a
              view over them.
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
              data-testid="collection-create"
              disabled={name.trim() === "" || saving}
            >
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
