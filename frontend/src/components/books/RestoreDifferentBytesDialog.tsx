import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { RestoreDifferentBytes, RestoreMode } from "@/types/domain";
import { joinList } from "./joinList";

interface RestoreDifferentBytesDialogProps {
  open: boolean;
  report: RestoreDifferentBytes | null;
  /** Title of the library entry that already owns the picked file, when known. */
  ownerTitle: string | null;
  busy: boolean;
  onChoose: (mode: RestoreMode) => void;
  onCancel: () => void;
}

/** What the forgotten snapshot still keeps, in the dialog's own words. */
function snapshotSummary(report: RestoreDifferentBytes): string {
  const bits: string[] = [];
  if (report.progressPercent !== null) {
    bits.push(`${Math.round(report.progressPercent)}% reading progress`);
  }
  if (report.annotationCount > 0) {
    bits.push(`${report.annotationCount} annotations`);
  }
  if (report.collections > 0) {
    bits.push(
      `${report.collections} collection ${report.collections === 1 ? "membership" : "memberships"}`,
    );
  }
  if (report.hasMetadataOverrides) bits.push("metadata edits");
  if (report.providerLinks > 0) {
    bits.push(`${report.providerLinks} provider ${report.providerLinks === 1 ? "link" : "links"}`);
  }
  return bits.length === 0 ? "no reading state" : joinList(bits);
}

/**
 * The different-bytes restore case (ADR 0019 D3): the picked file's bytes
 * match none of the snapshot's hashes, so the only choices are lossless.
 */
export function RestoreDifferentBytesDialog({
  open,
  report,
  ownerTitle,
  busy,
  onChoose,
  onCancel,
}: RestoreDifferentBytesDialogProps) {
  if (report === null) return null;
  const title = report.title?.trim() || "this book";
  const author = report.author?.trim() || null;
  const owner = ownerTitle?.trim() || null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent data-testid="restore-different-bytes-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>The picked file is not the one this book had</DialogTitle>
          <DialogDescription>
            {`The bytes do not match "${title}"${author ? ` by ${author}` : ""}, so nothing was attached. The trash entry is unchanged.`}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <p>The forgotten record still keeps {snapshotSummary(report)}.</p>
          <p className="mt-1 text-muted-foreground">
            Annotations stay with the restored record whatever you choose.
          </p>
        </div>
        {owner !== null && (
          <p className="text-sm">The picked file is already in your library as {`"${owner}"`}.</p>
        )}
        <div className="flex flex-col gap-2 text-sm">
          {owner !== null && (
            <p>
              <span className="font-medium">Link as an edition</span> keeps both entries: the record
              returns under Detached records, and {`"${owner}"`} gains the old progress and the
              provider link.
            </p>
          )}
          <p>
            <span className="font-medium">Restore without file</span> brings the record back under
            Detached records and leaves the picked file untouched.
          </p>
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="restore-different-bytes-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <div className="flex flex-wrap gap-2">
            {owner !== null && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="restore-different-bytes-link"
                disabled={busy}
                onClick={() => onChoose("link_edition")}
              >
                Link as an edition
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="restore-different-bytes-without-file"
              disabled={busy}
              onClick={() => onChoose("without_file")}
            >
              Restore without file
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
