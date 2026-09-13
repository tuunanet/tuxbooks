import { Fragment, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BookFormat, FileProperties } from "@/types/domain";

function PropertyList({ entries }: { entries: FileProperties["entries"] }) {
  if (entries.length === 0) {
    return (
      <p data-testid="file-properties-empty" className="text-sm text-muted-foreground">
        This file carries no readable metadata fields.
      </p>
    );
  }
  return (
    <dl
      data-testid="file-properties-list"
      className="grid grid-cols-[8rem_1fr] items-baseline gap-x-4 gap-y-1.5 text-sm"
    >
      {entries.map((entry) => (
        <Fragment key={entry.key}>
          <dt className="text-muted-foreground">{entry.key}</dt>
          <dd className="break-words">{entry.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export interface FilePropertiesPanelProps {
  format: BookFormat;
  properties: FileProperties | null;
  loading: boolean;
  error: string | null;
}

/**
 * Read-only "Original File Metadata" panel: what the source EPUB/PDF actually
 * carries, distinct from the library overrides and effective values. Reads
 * fresh from disk through `get_book_file_properties`.
 */
export function FilePropertiesPanel({
  format,
  properties,
  loading,
  error,
}: FilePropertiesPanelProps) {
  const [allOpen, setAllOpen] = useState(false);
  const entries = properties?.entries ?? [];
  const label = format.toUpperCase();

  return (
    <aside
      data-testid="file-properties"
      className="rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h3 className="text-sm font-semibold">Original File Metadata</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">Values from the book file ({label}).</p>

      <div className="mt-3 flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-2.5 text-xs text-sky-900 dark:text-sky-100">
        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <p>
          Some fields may not be available in {label} files. Changes in the Library tab do not
          modify the file unless you choose to write them into the file.
        </p>
      </div>

      <div className="mt-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading file metadata…</p>
        ) : error ? (
          <p data-testid="file-properties-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <PropertyList entries={entries} />
        )}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-4 w-full"
        data-testid="file-properties-view-all"
        disabled={loading || error !== null}
        onClick={() => setAllOpen(true)}
      >
        View all file properties…
      </Button>

      <div className="mt-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-xs text-emerald-900 dark:text-emerald-100">
        <p className="font-medium">Library metadata overrides</p>
        <p className="mt-1">
          Fields you changed are shown with an orange dot and will be used in your library. The
          original values are kept and can be restored at any time.
        </p>
      </div>

      <Dialog open={allOpen} onOpenChange={setAllOpen}>
        <DialogContent data-testid="file-properties-dialog" className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>File properties</DialogTitle>
            <DialogDescription>
              Every readable {label} metadata field in this file.
            </DialogDescription>
          </DialogHeader>
          <PropertyList entries={entries} />
        </DialogContent>
      </Dialog>
    </aside>
  );
}
