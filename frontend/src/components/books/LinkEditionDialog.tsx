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
import type { EditionBook } from "@/lib/bridge";

interface LinkEditionDialogProps {
  open: boolean;
  currentTitle?: string;
  candidates: EditionBook[];
  busy: boolean;
  error: string | null;
  onConfirm: (source: EditionBook) => void;
  onCancel: () => void;
}

/**
 * Confirmation for a cross-edition link (ADR 0014 D9). The two books stay
 * separate identities; this dialog is the place that makes the one-way state
 * transfer explicit before the user commits.
 */
export function LinkEditionDialog({
  open,
  currentTitle,
  candidates,
  busy,
  error,
  onConfirm,
  onCancel,
}: LinkEditionDialogProps) {
  const [selectedId, setSelectedId] = useState("");
  const selected = candidates.find((candidate) => String(candidate.id) === selectedId) ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="link-edition-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link another edition?</DialogTitle>
          <DialogDescription>
            {currentTitle === undefined
              ? "Confirm that another book is a different edition of the same work."
              : `Confirm that another book is the same work as ${currentTitle}.`}{" "}
            TuxBooks keeps both books as separate identities.
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <p data-testid="link-edition-empty" className="text-sm text-muted-foreground">
            {busy
              ? "Loading other books…"
              : "No other books are available to link. If the other edition is not in TuxBooks yet, import it or relink its file first, then link it here."}
          </p>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Other edition</span>
            <select
              data-testid="link-edition-select"
              aria-label="Other edition"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">Choose a book…</option>
              {candidates.map((candidate) => {
                const title = candidate.title?.trim() || "Unknown title";
                const author = candidate.author?.trim() || "Unknown author";
                const surface = candidate.inLibrary ? "Library" : "Reading history";
                return (
                  <option key={candidate.id} value={candidate.id}>
                    {`${title} · ${author} (${surface})`}
                  </option>
                );
              })}
            </select>
          </label>
        )}

        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">What linking does</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Reading progress copies as a percentage only; no locator crosses editions.</li>
            <li>The provider link and its reading status move to this edition.</li>
            <li data-testid="link-edition-annotation-note">
              Annotations stay with the other edition; they do not move automatically.
            </li>
          </ul>
        </div>

        {error !== null ? (
          <p data-testid="link-edition-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="link-edition-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="link-edition-confirm"
            disabled={selected === null || busy}
            onClick={() => {
              if (selected !== null) onConfirm(selected);
            }}
          >
            {busy ? "Linking…" : "Link editions"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
