import { useState } from "react";
import { FileDown, Loader2, RotateCcw } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useBookMetadata } from "@/hooks/useBookMetadata";
import { coverFileUrl, pickCoverImage } from "@/lib/bridge";
import type { BookMetadata, MetadataFields } from "@/types/domain";

/** Text-only mirror of `MetadataFields` for controlled inputs. */
interface MetadataFormState {
  title: string;
  subtitle: string;
  authors: string;
  subjects: string;
  publisher: string;
  language: string;
  isbn: string;
  publicationDate: string;
  series: string;
  seriesIndex: string;
  description: string;
}

function toForm(fields: MetadataFields): MetadataFormState {
  return {
    title: fields.title,
    subtitle: fields.subtitle ?? "",
    authors: fields.authors.join(", "),
    subjects: fields.subjects.join(", "),
    publisher: fields.publisher ?? "",
    language: fields.language ?? "",
    isbn: fields.isbn ?? "",
    publicationDate: fields.publicationDate ?? "",
    series: fields.series ?? "",
    seriesIndex: fields.seriesIndex === null ? "" : String(fields.seriesIndex),
    description: fields.description ?? "",
  };
}

function fromForm(state: MetadataFormState): MetadataFields {
  const list = (value: string) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      // Preserve order while dropping duplicate entries.
      .filter((entry, index, all) => all.indexOf(entry) === index);
  const index = Number(state.seriesIndex);
  return {
    title: state.title.trim(),
    subtitle: state.subtitle.trim() || null,
    authors: list(state.authors),
    subjects: list(state.subjects),
    publisher: state.publisher.trim() || null,
    language: state.language.trim() || null,
    isbn: state.isbn.trim() || null,
    publicationDate: state.publicationDate.trim() || null,
    series: state.series.trim() || null,
    seriesIndex: state.seriesIndex.trim() === "" || !Number.isFinite(index) ? null : index,
    description: state.description.trim() || null,
  };
}

/** Label with a marker when the stored value differs from the source file. */
function FieldLabel({
  htmlFor,
  children,
  overridden,
}: {
  htmlFor: string;
  children: string;
  overridden?: boolean;
}) {
  return (
    <Label htmlFor={htmlFor} className="flex items-center gap-1.5 text-sm font-medium">
      {children}
      {overridden && (
        <span
          data-testid={`${htmlFor}-overridden`}
          title="This value differs from the source file"
          aria-label="differs from the source file"
          className="size-1.5 rounded-full bg-amber-500"
        />
      )}
    </Label>
  );
}

/**
 * Shown under a field the user has changed: the file's own value plus a
 * one-click revert. Saving the file value back clears the override through
 * the backend's minimal-override rule, so this is a per-field reset. Fields
 * without this hint already show the file's value unchanged.
 */
function SourceValueHint({ value, onUseFile }: { value: string; onUseFile: () => void }) {
  return (
    <p className="text-xs text-muted-foreground">
      File:{" "}
      {value.trim() === "" ? (
        <span className="italic">none</span>
      ) : (
        <span className="line-clamp-2 break-words">{value}</span>
      )}{" "}
      <button
        type="button"
        className="underline underline-offset-2 hover:text-foreground"
        onClick={onUseFile}
      >
        Use file value
      </button>
    </p>
  );
}

export interface BookMetadataDialogProps {
  /** Book whose metadata is being curated; null disables the dialog. */
  bookId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Metadata and library curation (milestone 7). Edits are stored as library
 * overrides in the database; the explicit Embed into file action writes the
 * effective text metadata into the source EPUB/PDF (backing it up once).
 * Inline guidance explains the library-vs-file model, the "differs from the
 * file" marker, and the ambiguous fields; "Reset to source" returns the book
 * to exactly its file metadata.
 */
export function BookMetadataDialog({ bookId, open, onOpenChange }: BookMetadataDialogProps) {
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
    embed,
  } = useBookMetadata(open ? bookId : null);
  const [form, setForm] = useState<MetadataFormState | null>(null);
  const [formSource, setFormSource] = useState<BookMetadata | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);

  // Sync the draft whenever the curation view changes (initial load, save,
  // reset) — adjusted during render, not in an effect, so typing is never
  // clobbered and book switches never leak a stale draft.
  if (metadata !== formSource) {
    setFormSource(metadata);
    setForm(metadata ? toForm(metadata.effective) : null);
  }

  const close = () => onOpenChange(false);
  const set = (field: keyof MetadataFormState) => (value: string) =>
    setForm((current) => (current ? { ...current, [field]: value } : current));

  const onSave = async () => {
    if (!form || form.title.trim() === "") return;
    const saved = await save(fromForm(form));
    if (saved) close();
  };

  // Embed persists the form itself, so unsaved edits are included and the
  // user never has to Save first.
  const onEmbed = async () => {
    if (!form || form.title.trim() === "") return;
    await embed(fromForm(form));
  };

  const onChangeCover = async () => {
    setCoverBusy(true);
    try {
      const path = await pickCoverImage();
      if (path) await changeCover(path);
    } finally {
      setCoverBusy(false);
    }
  };

  const anyOverridden = metadata ? Object.values(metadata.overridden).some(Boolean) : false;

  // The file's own text values, shown under any field the user changed.
  const source = metadata?.source;
  const sourceText = {
    title: source?.title ?? "",
    subtitle: source?.subtitle ?? "",
    authors: (source?.authors ?? []).join(", "),
    publisher: source?.publisher ?? "",
    language: source?.language ?? "",
    isbn: source?.isbn ?? "",
    publicationDate: source?.publicationDate ?? "",
    series: source?.series ?? "",
    seriesIndex:
      source?.seriesIndex === null || source?.seriesIndex === undefined
        ? ""
        : String(source.seriesIndex),
    subjects: (source?.subjects ?? []).join(", "),
    description: source?.description ?? "",
  };
  const sourceSeriesUnit =
    sourceText.series === ""
      ? ""
      : sourceText.seriesIndex === ""
        ? sourceText.series
        : `${sourceText.series} · #${sourceText.seriesIndex}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="metadata-dialog"
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Edit Metadata</DialogTitle>
          <DialogDescription>
            Changes apply to your library right away; the book file stays as-is. Use Embed into file
            to also write them into the EPUB or PDF.
          </DialogDescription>
        </DialogHeader>

        {loading || !metadata || !form ? (
          <p
            data-testid="metadata-loading"
            className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
          >
            {error ? (
              <>
                <span data-testid="metadata-error" role="alert" className="text-destructive">
                  {error}
                </span>
              </>
            ) : (
              <>
                <Loader2 className="size-4 animate-spin" />
                Loading metadata…
              </>
            )}
          </p>
        ) : (
          <div className="grid gap-4">
            <p
              data-testid="metadata-override-legend"
              className="flex items-start gap-1.5 text-xs text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className="mt-1 size-1.5 shrink-0 rounded-full bg-amber-500"
              />
              Unmarked fields match the book file. Fields you changed get an orange dot and show the
              file&apos;s original value below them.
            </p>

            <div className="grid gap-1.5">
              <FieldLabel htmlFor="metadata-title" overridden={metadata.overridden.title}>
                Title (required)
              </FieldLabel>
              <Input
                id="metadata-title"
                data-testid="metadata-title"
                value={form.title}
                onChange={(event) => set("title")(event.target.value)}
              />
              {metadata.overridden.title && (
                <SourceValueHint
                  value={sourceText.title}
                  onUseFile={() => set("title")(sourceText.title)}
                />
              )}
            </div>

            <div className="grid gap-1.5">
              <FieldLabel htmlFor="metadata-subtitle" overridden={metadata.overridden.subtitle}>
                Subtitle
              </FieldLabel>
              <Input
                id="metadata-subtitle"
                data-testid="metadata-subtitle"
                value={form.subtitle}
                onChange={(event) => set("subtitle")(event.target.value)}
              />
              {metadata.overridden.subtitle && (
                <SourceValueHint
                  value={sourceText.subtitle}
                  onUseFile={() => set("subtitle")(sourceText.subtitle)}
                />
              )}
            </div>

            <div className="grid gap-1.5">
              <FieldLabel htmlFor="metadata-authors" overridden={metadata.overridden.authors}>
                Authors (comma separated)
              </FieldLabel>
              <Input
                id="metadata-authors"
                data-testid="metadata-authors"
                value={form.authors}
                onChange={(event) => set("authors")(event.target.value)}
              />
              {metadata.overridden.authors && (
                <SourceValueHint
                  value={sourceText.authors}
                  onUseFile={() => set("authors")(sourceText.authors)}
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="metadata-publisher" overridden={metadata.overridden.publisher}>
                  Publisher
                </FieldLabel>
                <Input
                  id="metadata-publisher"
                  data-testid="metadata-publisher"
                  value={form.publisher}
                  onChange={(event) => set("publisher")(event.target.value)}
                />
                {metadata.overridden.publisher && (
                  <SourceValueHint
                    value={sourceText.publisher}
                    onUseFile={() => set("publisher")(sourceText.publisher)}
                  />
                )}
              </div>
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="metadata-language" overridden={metadata.overridden.language}>
                  Language
                </FieldLabel>
                <Input
                  id="metadata-language"
                  data-testid="metadata-language"
                  value={form.language}
                  onChange={(event) => set("language")(event.target.value)}
                />
                {metadata.overridden.language && (
                  <SourceValueHint
                    value={sourceText.language}
                    onUseFile={() => set("language")(sourceText.language)}
                  />
                )}
              </div>
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="metadata-isbn" overridden={metadata.overridden.isbn}>
                  ISBN
                </FieldLabel>
                <Input
                  id="metadata-isbn"
                  data-testid="metadata-isbn"
                  placeholder="e.g. 978-3-16-148410-0"
                  value={form.isbn}
                  onChange={(event) => set("isbn")(event.target.value)}
                />
                {metadata.overridden.isbn && (
                  <SourceValueHint
                    value={sourceText.isbn}
                    onUseFile={() => set("isbn")(sourceText.isbn)}
                  />
                )}
              </div>
              <div className="grid gap-1.5">
                <FieldLabel
                  htmlFor="metadata-date"
                  overridden={metadata.overridden.publicationDate}
                >
                  Publication date
                </FieldLabel>
                <Input
                  id="metadata-date"
                  data-testid="metadata-date"
                  placeholder="e.g. 1843 or 1843-05-01"
                  value={form.publicationDate}
                  onChange={(event) => set("publicationDate")(event.target.value)}
                />
                {metadata.overridden.publicationDate && (
                  <SourceValueHint
                    value={sourceText.publicationDate}
                    onUseFile={() => set("publicationDate")(sourceText.publicationDate)}
                  />
                )}
              </div>
            </div>

            <div className="grid gap-1.5">
              <div className="grid grid-cols-[1fr_5rem] gap-3">
                <div className="grid gap-1.5">
                  <FieldLabel htmlFor="metadata-series" overridden={metadata.overridden.series}>
                    Series
                  </FieldLabel>
                  <Input
                    id="metadata-series"
                    data-testid="metadata-series"
                    value={form.series}
                    onChange={(event) => set("series")(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="metadata-series-index">Entry</Label>
                  <Input
                    id="metadata-series-index"
                    data-testid="metadata-series-index"
                    inputMode="decimal"
                    placeholder="e.g. 2"
                    title="The book's position within the series"
                    value={form.seriesIndex}
                    onChange={(event) => set("seriesIndex")(event.target.value)}
                  />
                </div>
              </div>
              {metadata.overridden.series ? (
                <SourceValueHint
                  value={sourceSeriesUnit}
                  onUseFile={() => {
                    set("series")(sourceText.series);
                    set("seriesIndex")(sourceText.seriesIndex);
                  }}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Entry is the book&apos;s position within the series.
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <FieldLabel htmlFor="metadata-subjects" overridden={metadata.overridden.subjects}>
                Subjects (comma separated)
              </FieldLabel>
              <Input
                id="metadata-subjects"
                data-testid="metadata-subjects"
                value={form.subjects}
                onChange={(event) => set("subjects")(event.target.value)}
              />
              {metadata.overridden.subjects && (
                <SourceValueHint
                  value={sourceText.subjects}
                  onUseFile={() => set("subjects")(sourceText.subjects)}
                />
              )}
            </div>

            <div className="grid gap-1.5">
              <FieldLabel
                htmlFor="metadata-description"
                overridden={metadata.overridden.description}
              >
                Description
              </FieldLabel>
              <Textarea
                id="metadata-description"
                data-testid="metadata-description"
                rows={4}
                value={form.description}
                onChange={(event) => set("description")(event.target.value)}
              />
              {metadata.overridden.description && (
                <SourceValueHint
                  value={sourceText.description}
                  onUseFile={() => set("description")(sourceText.description)}
                />
              )}
            </div>

            <Separator />

            <div className="flex items-center gap-3">
              {metadata.coverPath ? (
                <img
                  data-testid="metadata-cover-thumb"
                  src={coverFileUrl(metadata.coverPath)}
                  alt=""
                  className="h-16 w-11 rounded border object-cover"
                />
              ) : (
                <div
                  data-testid="metadata-cover-placeholder"
                  className="flex h-16 w-11 items-center justify-center rounded border text-xs text-muted-foreground"
                >
                  None
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Cover</span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="metadata-cover-change"
                    title="Choose an image for the library; the book file's cover is unchanged"
                    disabled={coverBusy}
                    onClick={() => void onChangeCover()}
                  >
                    {coverBusy ? <Loader2 className="size-3 animate-spin" /> : null}
                    Change cover…
                  </Button>
                  {metadata.overridden.cover && (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="metadata-cover-restore"
                      title="Go back to the cover taken from the book file"
                      onClick={() => void restoreCover()}
                    >
                      Restore extracted cover
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Shown in your library only; the book file keeps its own cover.
                </p>
              </div>
            </div>

            {error && (
              <p data-testid="metadata-error" className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            {embedError && (
              <p
                data-testid="metadata-embed-error"
                className="text-sm text-destructive"
                role="alert"
              >
                {embedError}
              </p>
            )}

            {embedSuccess && !embedError && (
              <p
                data-testid="metadata-embed-success"
                role="status"
                className="text-sm text-emerald-600 dark:text-emerald-400"
              >
                {anyOverridden
                  ? "Written into the book file. Values this format can't store stay as library edits."
                  : "Written into the book file — no need to Save."}
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              Save keeps these edits in your library. Embed into file writes them into the book and
              saves too, so you can skip Save; a one-time <span className="font-mono">.bak</span>{" "}
              backup is kept.
            </p>
          </div>
        )}

        <DialogFooter className="mt-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="metadata-reset"
              title="Discard your library edits and use the book file's values"
              disabled={!metadata || saving || loading || !anyOverridden}
              onClick={() => void reset()}
            >
              <RotateCcw data-icon="inline-start" />
              Reset to source
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="metadata-embed"
              title="Write these values into the EPUB/PDF (a one-time .bak backup is kept)"
              disabled={!form || form.title.trim() === "" || saving || embedding || loading}
              onClick={() => void onEmbed()}
            >
              {embedding ? (
                <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
              ) : (
                <FileDown data-icon="inline-start" />
              )}
              Embed into file
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" data-testid="metadata-cancel" onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="metadata-save"
              title="Save to your library (the book file is not changed)"
              disabled={saving || loading || !form || form.title.trim() === ""}
              onClick={() => void onSave()}
            >
              {saving && <Loader2 data-icon="inline-start" className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
