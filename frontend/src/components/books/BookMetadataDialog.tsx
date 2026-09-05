import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
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
import { coverFileUrl, pickCoverImage } from "@/lib/tauri";
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

export interface BookMetadataDialogProps {
  /** Book whose metadata is being curated; null disables the dialog. */
  bookId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Metadata and library curation (milestone 7). Edits are stored as library
 * overrides in the database — the source EPUB/PDF files are never rewritten.
 * Fields that carry an override are marked; "Reset to source" returns the
 * book to exactly its file metadata.
 */
export function BookMetadataDialog({ bookId, open, onOpenChange }: BookMetadataDialogProps) {
  const { metadata, loading, saving, error, save, reset, changeCover, restoreCover } =
    useBookMetadata(open ? bookId : null);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="metadata-dialog"
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Edit Metadata</DialogTitle>
          <DialogDescription>
            Edits are stored as library overrides — the source file is never modified. Marked fields
            differ from the file.
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
            <div className="grid gap-1.5">
              <FieldLabel htmlFor="metadata-title" overridden={metadata.overridden.title}>
                Title
              </FieldLabel>
              <Input
                id="metadata-title"
                data-testid="metadata-title"
                value={form.title}
                onChange={(event) => set("title")(event.target.value)}
              />
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
              </div>
              <div className="grid gap-1.5">
                <FieldLabel htmlFor="metadata-isbn" overridden={metadata.overridden.isbn}>
                  ISBN
                </FieldLabel>
                <Input
                  id="metadata-isbn"
                  data-testid="metadata-isbn"
                  value={form.isbn}
                  onChange={(event) => set("isbn")(event.target.value)}
                />
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
              </div>
            </div>

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
                  value={form.seriesIndex}
                  onChange={(event) => set("seriesIndex")(event.target.value)}
                />
              </div>
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
                      onClick={() => void restoreCover()}
                    >
                      Restore extracted cover
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {error && (
              <p data-testid="metadata-error" className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="mt-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            data-testid="metadata-reset"
            disabled={!metadata || saving || loading || !anyOverridden}
            onClick={() => void reset()}
          >
            <RotateCcw data-icon="inline-start" />
            Reset to source
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" data-testid="metadata-cancel" onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="metadata-save"
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
