import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  BookFormat,
  BookMetadata,
  MetadataFieldSource,
  MetadataFieldSources,
} from "@/types/domain";
import type { MetadataFieldKey } from "@/lib/fileMetadataCapabilities";
import { FieldLabel } from "./FieldLabel";
import { ListEditor } from "./ListEditor";
import { SourceValueHint } from "./SourceValueHint";
import type { MetadataFormState } from "./metadataForm";

export type MetadataFormChange = <K extends keyof MetadataFormState>(
  field: K,
  value: MetadataFormState[K],
) => void;

export interface MetadataFieldGridProps {
  form: MetadataFormState;
  metadata: BookMetadata;
  onChange: MetadataFormChange;
  format?: BookFormat;
  /** Which fields are editable; the rest render disabled as "Library only". */
  isEditable?: (field: MetadataFieldKey) => boolean;
  /** Explicit per-field authority choices, with their setter. */
  fieldSources?: MetadataFieldSources;
  onSetFieldSource?: (
    field: keyof MetadataFieldSources,
    source: MetadataFieldSource | null,
  ) => void;
}

function LibraryOnly({ id, format }: { id: string; format?: BookFormat }) {
  return (
    <p data-testid={`${id}-library-only`} className="text-xs text-muted-foreground">
      Library only{format ? ` — ${format.toUpperCase()} cannot store this field` : ""}.
    </p>
  );
}

/** The editable bibliographic fields, shared by the two detail sub-tabs. */
export function MetadataFieldGrid({
  form,
  metadata,
  onChange,
  format,
  isEditable = () => true,
  fieldSources,
  onSetFieldSource,
}: MetadataFieldGridProps) {
  const locked = (field: MetadataFieldKey) => !isEditable(field);
  // A locked field explains itself; otherwise a changed field shows the file
  // value it diverged from and the library-vs-file choice.
  const note = (field: MetadataFieldKey, id: string) =>
    locked(field) ? <LibraryOnly id={id} format={format} /> : null;
  const sourceControl = (
    field: keyof MetadataFieldSources,
    fileValue: string,
    overridden: boolean,
  ) =>
    !locked(field) && overridden && onSetFieldSource ? (
      <SourceValueHint
        source={fieldSources?.[field] ?? null}
        fileValue={fileValue}
        onSetSource={(source) => onSetFieldSource(field, source)}
      />
    ) : null;

  const source = metadata.source;
  // The file's own text values, shown under any field the user changed.
  const sourceText = {
    title: source.title,
    subtitle: source.subtitle ?? "",
    authors: source.authors.join(", "),
    publisher: source.publisher ?? "",
    language: source.language ?? "",
    isbn: source.isbn ?? "",
    publicationDate: source.publicationDate ?? "",
    series: source.series ?? "",
    seriesIndex: source.seriesIndex === null ? "" : String(source.seriesIndex),
    subjects: source.subjects.join(", "),
    description: source.description ?? "",
  };
  const sourceSeriesUnit =
    sourceText.series === ""
      ? ""
      : sourceText.seriesIndex === ""
        ? sourceText.series
        : `${sourceText.series} · #${sourceText.seriesIndex}`;

  return (
    <>
      <div className="grid gap-1.5">
        <FieldLabel htmlFor="metadata-title" overridden={metadata.overridden.title}>
          Title (required)
        </FieldLabel>
        <Input
          id="metadata-title"
          data-testid="metadata-title"
          disabled={locked("title")}
          value={form.title}
          onChange={(event) => onChange("title", event.target.value)}
        />
        {note("title", "metadata-title")}
        {sourceControl("title", sourceText.title, metadata.overridden.title)}
      </div>

      <div className="grid gap-1.5">
        <FieldLabel htmlFor="metadata-subtitle" overridden={metadata.overridden.subtitle}>
          Subtitle
        </FieldLabel>
        <Input
          id="metadata-subtitle"
          data-testid="metadata-subtitle"
          disabled={locked("subtitle")}
          value={form.subtitle}
          onChange={(event) => onChange("subtitle", event.target.value)}
        />
        {note("subtitle", "metadata-subtitle")}
        {sourceControl("subtitle", sourceText.subtitle, metadata.overridden.subtitle)}
      </div>

      <div className="grid gap-1.5">
        <FieldLabel htmlFor="metadata-authors" overridden={metadata.overridden.authors}>
          Authors
        </FieldLabel>
        <ListEditor
          id="metadata-authors"
          testId="metadata-authors"
          values={form.authors}
          disabled={locked("authors")}
          onChange={(authors) => onChange("authors", authors)}
          placeholder="Add an author"
          addLabel="Add author"
        />
        {note("authors", "metadata-authors")}
        {sourceControl("authors", sourceText.authors, metadata.overridden.authors)}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <FieldLabel htmlFor="metadata-publisher" overridden={metadata.overridden.publisher}>
            Publisher
          </FieldLabel>
          <Input
            id="metadata-publisher"
            data-testid="metadata-publisher"
            disabled={locked("publisher")}
            value={form.publisher}
            onChange={(event) => onChange("publisher", event.target.value)}
          />
          {note("publisher", "metadata-publisher")}
          {sourceControl("publisher", sourceText.publisher, metadata.overridden.publisher)}
        </div>
        <div className="grid gap-1.5">
          <FieldLabel htmlFor="metadata-language" overridden={metadata.overridden.language}>
            Language
          </FieldLabel>
          <Input
            id="metadata-language"
            data-testid="metadata-language"
            disabled={locked("language")}
            value={form.language}
            onChange={(event) => onChange("language", event.target.value)}
          />
          {note("language", "metadata-language")}
          {sourceControl("language", sourceText.language, metadata.overridden.language)}
        </div>
        <div className="grid gap-1.5">
          <FieldLabel htmlFor="metadata-isbn" overridden={metadata.overridden.isbn}>
            ISBN
          </FieldLabel>
          <Input
            id="metadata-isbn"
            data-testid="metadata-isbn"
            placeholder="e.g. 978-3-16-148410-0"
            disabled={locked("isbn")}
            value={form.isbn}
            onChange={(event) => onChange("isbn", event.target.value)}
          />
          {note("isbn", "metadata-isbn")}
          {sourceControl("isbn", sourceText.isbn, metadata.overridden.isbn)}
        </div>
        <div className="grid gap-1.5">
          <FieldLabel htmlFor="metadata-date" overridden={metadata.overridden.publicationDate}>
            Publication date
          </FieldLabel>
          <Input
            id="metadata-date"
            data-testid="metadata-date"
            placeholder="e.g. 1843 or 1843-05-01"
            disabled={locked("publicationDate")}
            value={form.publicationDate}
            onChange={(event) => onChange("publicationDate", event.target.value)}
          />
          {note("publicationDate", "metadata-date")}
          {sourceControl(
            "publicationDate",
            sourceText.publicationDate,
            metadata.overridden.publicationDate,
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
              disabled={locked("series")}
              value={form.series}
              onChange={(event) => onChange("series", event.target.value)}
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
              disabled={locked("seriesIndex")}
              value={form.seriesIndex}
              onChange={(event) => onChange("seriesIndex", event.target.value)}
            />
          </div>
        </div>
        {locked("series") ? (
          <LibraryOnly id="metadata-series" format={format} />
        ) : (
          (sourceControl("series", sourceSeriesUnit, metadata.overridden.series) ?? (
            <p className="text-xs text-muted-foreground">
              Entry is the book&apos;s position within the series.
            </p>
          ))
        )}
      </div>

      <div className="grid gap-1.5">
        <FieldLabel htmlFor="metadata-subjects" overridden={metadata.overridden.subjects}>
          Subjects / Tags
        </FieldLabel>
        <ListEditor
          id="metadata-subjects"
          testId="metadata-subjects"
          values={form.subjects}
          disabled={locked("subjects")}
          onChange={(subjects) => onChange("subjects", subjects)}
          placeholder="Add a subject"
          addLabel="Add subject"
        />
        {note("subjects", "metadata-subjects")}
        {sourceControl("subjects", sourceText.subjects, metadata.overridden.subjects)}
      </div>

      <div className="grid gap-1.5">
        <FieldLabel htmlFor="metadata-description" overridden={metadata.overridden.description}>
          Description
        </FieldLabel>
        <Textarea
          id="metadata-description"
          data-testid="metadata-description"
          rows={4}
          disabled={locked("description")}
          value={form.description}
          onChange={(event) => onChange("description", event.target.value)}
        />
        {note("description", "metadata-description")}
        {sourceControl("description", sourceText.description, metadata.overridden.description)}
      </div>
    </>
  );
}
