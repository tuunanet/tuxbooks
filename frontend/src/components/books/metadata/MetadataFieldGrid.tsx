import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { BookMetadata } from "@/types/domain";
import { FieldLabel } from "./FieldLabel";
import { ListEditor } from "./ListEditor";
import type { MetadataFormState } from "./metadataForm";

export type MetadataFormChange = <K extends keyof MetadataFormState>(
  field: K,
  value: MetadataFormState[K],
) => void;

export interface MetadataFieldGridProps {
  form: MetadataFormState;
  metadata: BookMetadata;
  onChange: MetadataFormChange;
}

/** The editable bibliographic fields of the metadata form. */
export function MetadataFieldGrid({ form, metadata, onChange }: MetadataFieldGridProps) {
  return (
    <>
      <div className="grid gap-1.5">
        <FieldLabel htmlFor="metadata-title" overridden={metadata.overridden.title}>
          Title (required)
        </FieldLabel>
        <Input
          id="metadata-title"
          data-testid="metadata-title"
          value={form.title}
          onChange={(event) => onChange("title", event.target.value)}
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
          onChange={(event) => onChange("subtitle", event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <FieldLabel htmlFor="metadata-authors" overridden={metadata.overridden.authors}>
          Authors
        </FieldLabel>
        <ListEditor
          id="metadata-authors"
          testId="metadata-authors"
          values={form.authors}
          onChange={(authors) => onChange("authors", authors)}
          placeholder="Add an author"
          addLabel="Add author"
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
            onChange={(event) => onChange("publisher", event.target.value)}
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
            onChange={(event) => onChange("language", event.target.value)}
          />
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
            onChange={(event) => onChange("isbn", event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <FieldLabel htmlFor="metadata-date" overridden={metadata.overridden.publicationDate}>
            Publication date
          </FieldLabel>
          <Input
            id="metadata-date"
            data-testid="metadata-date"
            placeholder="e.g. 1843 or 1843-05-01"
            value={form.publicationDate}
            onChange={(event) => onChange("publicationDate", event.target.value)}
          />
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
              value={form.seriesIndex}
              onChange={(event) => onChange("seriesIndex", event.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Entry is the book&apos;s position within the series.
        </p>
      </div>

      <div className="grid gap-1.5">
        <FieldLabel htmlFor="metadata-subjects" overridden={metadata.overridden.subjects}>
          Subjects / Tags
        </FieldLabel>
        <ListEditor
          id="metadata-subjects"
          testId="metadata-subjects"
          values={form.subjects}
          onChange={(subjects) => onChange("subjects", subjects)}
          placeholder="Add a subject"
          addLabel="Add subject"
        />
      </div>

      <div className="grid gap-1.5">
        <FieldLabel htmlFor="metadata-description" overridden={metadata.overridden.description}>
          Description
        </FieldLabel>
        <Textarea
          id="metadata-description"
          data-testid="metadata-description"
          rows={4}
          value={form.description}
          onChange={(event) => onChange("description", event.target.value)}
        />
      </div>
    </>
  );
}
