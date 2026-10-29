import { useState } from "react";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { Book, BookMetadata } from "@/types/domain";
import type { BookMetadataCuration } from "@/hooks/useBookMetadata";
import { CoverField } from "./metadata/CoverField";
import { MetadataFieldGrid } from "./metadata/MetadataFieldGrid";
import { fromForm, toForm, type MetadataFormState } from "./metadata/metadataForm";

export interface MetadataPanelProps {
  book: Book;
  curation: BookMetadataCuration;
}

/**
 * The detail view's single metadata form (issue #58, simplified). One set of
 * fields, one Save: the backend persists the edits and writes the fields the
 * format supports into the file behind a one-time `.bak` backup; fields the
 * format cannot store stay as library edits. The cover block curates the
 * library cover only — the book file's own cover is never touched.
 */
export function MetadataPanel({ book, curation }: MetadataPanelProps) {
  const {
    metadata,
    loading,
    saving,
    embedding,
    error,
    embedError,
    embedSuccess,
    reset,
    changeCover,
    restoreCover,
    embed,
  } = curation;
  const [form, setForm] = useState<MetadataFormState | null>(null);
  const [formSource, setFormSource] = useState<BookMetadata | null>(null);

  // Sync the draft whenever the curation view changes (initial load, save,
  // reset) — adjusted during render, not in an effect, so typing is never
  // clobbered and book switches never leak a stale draft.
  if (metadata !== formSource) {
    setFormSource(metadata);
    setForm(metadata ? toForm(metadata.effective) : null);
  }

  const set = <K extends keyof MetadataFormState>(field: K, value: MetadataFormState[K]) => {
    setForm((current) => (current ? { ...current, [field]: value } : current));
  };

  const baseline = metadata ? toForm(metadata.effective) : null;
  const dirty =
    form !== null && baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline);
  const canSubmit = form !== null && form.title.trim() !== "" && dirty;

  const onSave = async () => {
    if (!form || !canSubmit) return;
    await embed(fromForm(form));
  };

  const onCancel = () => {
    setForm(baseline);
  };

  const anyOverridden = metadata ? Object.values(metadata.overridden).some(Boolean) : false;
  const formatLabel = book.format.toUpperCase();

  return (
    <div data-testid="metadata-panel" className="mt-6">
      <div className="rounded-lg border bg-card p-5 text-card-foreground">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Edit Metadata</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Edit this book&apos;s details. Saving writes what the {formatLabel} format supports
              into the file; the rest stays in your library.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="metadata-panel-reset"
            title="Restore the book file's values. Your library edits are removed; the file itself is never touched."
            disabled={!metadata || saving || embedding || loading || !anyOverridden}
            onClick={() => void reset()}
          >
            <RotateCcw data-icon="inline-start" />
            Discard library edits
          </Button>
        </div>

        {loading || !metadata || !form ? (
          <p
            data-testid="metadata-panel-loading"
            className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
          >
            {error ? (
              <span data-testid="metadata-panel-error" role="alert" className="text-destructive">
                {error}
              </span>
            ) : (
              <>
                <Loader2 className="size-4 animate-spin" />
                Loading metadata…
              </>
            )}
          </p>
        ) : (
          <>
            <div className="mt-4 flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-2.5 text-xs text-sky-900 dark:text-sky-100">
              <div className="flex flex-col gap-1.5">
                <p>
                  Saving writes these values into the {formatLabel} file. Other machines get them
                  only when they receive the file. Fields {formatLabel} cannot store stay as library
                  edits.
                </p>
                <p data-testid="metadata-panel-backup-note">
                  The first save creates a one-time <span className="font-mono">.bak</span> copy
                  next to the book; later saves keep it. If the book folder is cloud-synced, the
                  backup travels with it, and deleting it there removes it on every machine.
                  TuxBooks cannot recreate the original after that.
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-4">
              <MetadataFieldGrid form={form} metadata={metadata} onChange={set} />
            </div>

            <Separator className="my-4" />

            <CoverField
              metadata={metadata}
              onChangeCover={changeCover}
              onRestoreCover={restoreCover}
            />
          </>
        )}

        {embedError && (
          <p
            data-testid="metadata-panel-save-error"
            className="mt-4 text-sm text-destructive"
            role="alert"
          >
            {embedError}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {embedSuccess && !embedError && (
            <span
              data-testid="metadata-panel-saved"
              role="status"
              className="mr-auto text-sm text-emerald-600 dark:text-emerald-400"
            >
              {anyOverridden
                ? `Saved. Fields ${formatLabel} cannot store stay as library edits.`
                : `Saved. Written into the ${formatLabel} file.`}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            data-testid="metadata-panel-cancel"
            disabled={!form || !dirty || saving || embedding}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="metadata-panel-save"
            title={`Save changes; storeable fields are written into the ${formatLabel} (a one-time .bak backup is kept)`}
            disabled={!canSubmit || saving || embedding || loading}
            onClick={() => void onSave()}
          >
            {embedding ? (
              <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
            ) : (
              <Save data-icon="inline-start" />
            )}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
