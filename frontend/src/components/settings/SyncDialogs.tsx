/**
 * The modal surfaces of Settings > Sync: the library-mismatch prompt, the
 * disconnect confirmation, and the device-name editor. `MismatchPrompt` is the
 * shape of the mismatch state the container holds.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SyncMismatch } from "@/lib/bridge";

export type MismatchPrompt = {
  path: string;
  mismatch: SyncMismatch;
};

type SyncMismatchDialogProps = {
  mismatch: MismatchPrompt | null;
  busy: boolean;
  onCancel: () => void;
  onStartNew: () => void;
  onConfirmJoin: () => void;
};

export function SyncMismatchDialog({
  mismatch,
  busy,
  onCancel,
  onStartNew,
  onConfirmJoin,
}: SyncMismatchDialogProps) {
  return (
    <Dialog open={mismatch !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="sync-mismatch">
        <DialogHeader>
          <DialogTitle>This folder already has a TuxBooks library</DialogTitle>
          <DialogDescription>
            TuxBooks found an existing sync library here. Use it to merge this device&apos;s reading
            state into it, or start a new library here. Starting a new one keeps the old library in
            a backup folder beside it. Your books and files are not moved. Other devices using this
            folder will need to reconnect to the backup.
          </DialogDescription>
        </DialogHeader>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {mismatch?.mismatch.remoteLibraryId}
        </p>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            data-testid="sync-start-new"
            variant="outline"
            onClick={onStartNew}
            disabled={busy}
          >
            Start a new library here
          </Button>
          <Button data-testid="sync-confirm-join" onClick={onConfirmJoin} disabled={busy}>
            Use this library
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type DisconnectDialogProps = {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DisconnectDialog({
  open,
  busy,
  onOpenChange,
  onCancel,
  onConfirm,
}: DisconnectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="sync-disconnect-dialog">
        <DialogHeader>
          <DialogTitle>Disconnect this device?</DialogTitle>
          <DialogDescription>
            Syncing stops on this machine. The sync folder is left untouched, so another machine can
            keep using it or you can reconnect later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="sync-confirm-disconnect"
            onClick={onConfirm}
            disabled={busy}
          >
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type DeviceNameDialogProps = {
  open: boolean;
  initialName: string;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onSave: (name: string) => void;
};

export function DeviceNameDialog({
  open,
  initialName,
  busy,
  onOpenChange,
  onCancel,
  onSave,
}: DeviceNameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="sync-device-dialog">
        <DeviceNameForm initialName={initialName} busy={busy} onCancel={onCancel} onSave={onSave} />
      </DialogContent>
    </Dialog>
  );
}

type DeviceNameFormProps = {
  initialName: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string) => void;
};

/**
 * Owns the draft so a status refresh in the parent cannot overwrite the field.
 * Radix unmounts the dialog content when it closes, so each open reseeds from
 * the stored name.
 */
export function DeviceNameForm({ initialName, busy, onCancel, onSave }: DeviceNameFormProps) {
  const [name, setName] = useState(initialName);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Device name</DialogTitle>
        <DialogDescription>
          Shown in this app so you can tell machines apart. Other machines read it from the sync
          folder.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor="sync-device-input">Name</Label>
        <Input
          id="sync-device-input"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          data-testid="sync-save-device"
          onClick={() => onSave(name)}
          disabled={busy || name.trim().length === 0}
        >
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
