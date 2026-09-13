import { useState } from "react";
import { FileDown, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBookFileProperties } from "@/hooks/useBookFileProperties";
import type { BookMetadataCuration } from "@/hooks/useBookMetadata";
import { isFileWritable } from "@/lib/fileMetadataCapabilities";
import type { Book, BookMetadata } from "@/types/domain";
import { CoverField } from "./metadata/CoverField";
import { MetadataFieldGrid } from "./metadata/MetadataFieldGrid";
import { fromForm, toForm, type MetadataFormState } from "./metadata/metadataForm";
import { FilePropertiesPanel } from "./FilePropertiesPanel";

export interface MetadataPanelProps {
  book: Book;
  curation: BookMetadataCuration;
}

/**
 * The detail view's primary metadata surface (issue #58). The Library tab
 * edits the book's metadata as SQLite overrides (the source file is never
 * touched). The File tab gates the same fields to what the format's writer
 * can store and embeds them through the atomic `<file>.bak` path.
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
    save,
    reset,
    changeCover,
    restoreCover,
    setFieldSource,
    embed,
  } = curation;
  const file = useBookFileProperties(book.id);
  const [form, setForm] = useState<MetadataFormState | null>(null);
  const [formSource, setFormSource] = useState<BookMetadata | null>(null);
  // The active tab decides what the footer's primary action does: the Library
  // tab saves SQLite overrides, the File tab embeds into the file. One action
  // per tab — no hidden "write to file" modes.
  const [tab, setTab] = useState<"library" | "file">("library");
  // The curation view returned by the last save; identifies the saved state
  // by reference so a later edit, reset, or book switch hides the indicator.
  const [savedView, setSavedView] = useState<BookMetadata | null>(null);

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

  const onSaveChanges = async () => {
    if (!form || !canSubmit) return;
    const result = await save(fromForm(form));
    if (result) setSavedView(result);
  };

  const onEmbed = async () => {
    if (!form || !canSubmit) return;
    await embed(fromForm(form));
  };

  const onCancel = () => {
    setForm(baseline);
  };

  const saved = savedView !== null && savedView === metadata && !dirty;
  const anyOverridden = metadata ? Object.values(metadata.overridden).some(Boolean) : false;
  const formatLabel = book.format.toUpperCase();

  return (
    <div data-testid="metadata-panel" className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="rounded-lg border bg-card p-5 text-card-foreground">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Edit Metadata</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Edit how this book appears in your library. You can also write changes back to the
              file.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="metadata-panel-reset"
            title="Discard library edits and use the book file's values"
            disabled={!metadata || saving || embedding || loading || !anyOverridden}
            onClick={() => void reset()}
          >
            <RotateCcw data-icon="inline-start" />
            Reset to source
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
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as "library" | "file")}
            className="mt-4"
          >
            <TabsList data-testid="metadata-panel-tabs">
              <TabsTrigger value="library" data-testid="metadata-tab-library">
                Library Metadata
              </TabsTrigger>
              <TabsTrigger value="file" data-testid="metadata-tab-file">
                File Metadata
              </TabsTrigger>
            </TabsList>

            <TabsContent value="library">
              <p
                data-testid="metadata-panel-legend"
                className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground"
              >
                <span
                  aria-hidden="true"
                  className="mt-1 size-1.5 shrink-0 rounded-full bg-amber-500"
                />
                An orange dot marks fields whose library value differs from the book file — the
                file&apos;s original value is shown below the field. Fields without a dot match the
                file.
              </p>

              <div className="mt-4 grid gap-4">
                <MetadataFieldGrid
                  form={form}
                  metadata={metadata}
                  onChange={set}
                  fieldSources={metadata.fieldSources}
                  onSetFieldSource={setFieldSource}
                />
              </div>

              <Separator className="my-4" />

              <CoverField
                metadata={metadata}
                onChangeCover={changeCover}
                onRestoreCover={restoreCover}
              />
            </TabsContent>

            <TabsContent value="file">
              <div className="mt-4 flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-2.5 text-xs text-sky-900 dark:text-sky-100">
                <p>
                  Embedding writes these values into the {formatLabel} file, keeping a one-time{" "}
                  {formatLabel.toLowerCase()} <span className="font-mono">.bak</span> backup. Fields{" "}
                  {formatLabel} cannot store stay as library edits and are marked below.
                </p>
              </div>

              <div className="mt-4 grid gap-4">
                <MetadataFieldGrid
                  form={form}
                  metadata={metadata}
                  onChange={set}
                  format={book.format}
                  isEditable={(field) => isFileWritable(book.format, field)}
                />
              </div>
            </TabsContent>
          </Tabs>
        )}

        {embedError && (
          <p
            data-testid="metadata-panel-embed-error"
            className="mt-4 text-sm text-destructive"
            role="alert"
          >
            {embedError}
          </p>
        )}

        {embedSuccess && !embedError && (
          <p
            data-testid="metadata-panel-embed-success"
            role="status"
            className="mt-4 text-sm text-emerald-600 dark:text-emerald-400"
          >
            {anyOverridden
              ? `Written into the ${formatLabel} file. Values this format can't store stay as library edits.`
              : `Written into the ${formatLabel} file.`}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {saved && !dirty && (
            <span
              data-testid="metadata-panel-saved"
              role="status"
              className="mr-auto text-sm text-emerald-600 dark:text-emerald-400"
            >
              Saved to your library.
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
          {tab === "file" ? (
            <Button
              size="sm"
              data-testid="metadata-panel-embed"
              title={`Write these values into the ${formatLabel} (a one-time .bak backup is kept)`}
              disabled={!canSubmit || saving || embedding || loading}
              onClick={() => void onEmbed()}
            >
              {embedding ? (
                <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
              ) : (
                <FileDown data-icon="inline-start" />
              )}
              Embed into file
            </Button>
          ) : (
            <Button
              size="sm"
              data-testid="metadata-panel-save"
              disabled={!canSubmit || saving || embedding || loading}
              onClick={() => void onSaveChanges()}
            >
              {saving && <Loader2 data-icon="inline-start" className="size-4 animate-spin" />}
              Save Changes
            </Button>
          )}
        </div>
      </div>

      <FilePropertiesPanel
        format={book.format}
        properties={file.properties}
        loading={file.loading}
        error={file.error}
      />
    </div>
  );
}
