import type { MetadataFields } from "@/types/domain";

/** Editable mirror of `MetadataFields`; lists stay arrays for the chip editors. */
export interface MetadataFormState {
  title: string;
  subtitle: string;
  authors: string[];
  subjects: string[];
  publisher: string;
  language: string;
  isbn: string;
  publicationDate: string;
  series: string;
  seriesIndex: string;
  description: string;
}

export function toForm(fields: MetadataFields): MetadataFormState {
  return {
    title: fields.title,
    subtitle: fields.subtitle ?? "",
    authors: [...fields.authors],
    subjects: [...fields.subjects],
    publisher: fields.publisher ?? "",
    language: fields.language ?? "",
    isbn: fields.isbn ?? "",
    publicationDate: fields.publicationDate ?? "",
    series: fields.series ?? "",
    seriesIndex: fields.seriesIndex === null ? "" : String(fields.seriesIndex),
    description: fields.description ?? "",
  };
}

export function fromForm(state: MetadataFormState): MetadataFields {
  const index = Number(state.seriesIndex);
  return {
    title: state.title.trim(),
    subtitle: state.subtitle.trim() || null,
    authors: cleanList(state.authors),
    subjects: cleanList(state.subjects),
    publisher: state.publisher.trim() || null,
    language: state.language.trim() || null,
    isbn: state.isbn.trim() || null,
    publicationDate: state.publicationDate.trim() || null,
    series: state.series.trim() || null,
    seriesIndex: state.seriesIndex.trim() === "" || !Number.isFinite(index) ? null : index,
    description: state.description.trim() || null,
  };
}

/** Trim, drop empties, and de-duplicate while preserving order. */
function cleanList(values: string[]): string[] {
  const cleaned: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "" && !cleaned.includes(trimmed)) {
      cleaned.push(trimmed);
    }
  }
  return cleaned;
}
