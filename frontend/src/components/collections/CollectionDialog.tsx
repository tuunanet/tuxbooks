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

interface CollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: boolean;
}

/**
 * Create-collection dialog shell. There is no `create_collection` command on
 * the IPC surface yet, so creation is deliberately disabled — the dialog
 * exists so the flow and layout are real, and it says so instead of faking a
 * save that would silently vanish on restart.
 */
export function CollectionDialog({ open, onOpenChange, trigger = true }: CollectionDialogProps) {
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
        <DialogHeader>
          <DialogTitle>New Collection</DialogTitle>
          <DialogDescription>
            Group books into named collections. Creation is not connected to the Rust backend yet —
            nothing will be saved.
          </DialogDescription>
        </DialogHeader>
        <Input
          data-testid="collection-name"
          aria-label="Collection name"
          placeholder="Collection name"
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="collection-create"
            disabled
            title="Creating collections will be connected to the Rust backend"
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
