import type { BookFormat } from "@/types/domain";

/**
 * How a format is rendered. A format is what the file is; an engine is which
 * reader draws it. One engine can serve several formats while another stays
 * deliberately single-format, so the two are separate axes (ADR 0012).
 */
export type RenderEngine = "readium" | "pdfium";

interface FormatInfo {
  /** Display name, reused as the option label in the library format filter. */
  label: string;
  engine: RenderEngine;
}

/**
 * Every format the library accepts, in display order. The sidecar owns
 * file-kind detection (Rust `BookFormat`); this table owns how the renderer
 * presents it. Adding a format here is enough: the filter options and the
 * reader dispatch both derive from it.
 */
export const FORMATS: Record<BookFormat, FormatInfo> = {
  epub: { label: "EPUB", engine: "readium" },
  pdf: { label: "PDF", engine: "pdfium" },
};

/** Options for the library header's format filter, in display order. */
export const FORMAT_FILTER_OPTIONS: readonly { id: BookFormat; label: string }[] = (
  Object.keys(FORMATS) as BookFormat[]
).map((id) => ({ id, label: FORMATS[id].label }));

/**
 * Adds or removes one format and returns the set in registry order, so the
 * stored selection stays canonical wherever it is edited.
 */
export function toggleFormatFilter(
  formats: readonly BookFormat[],
  id: BookFormat,
  selected: boolean,
): BookFormat[] {
  const next = new Set(formats);
  if (selected) next.add(id);
  else next.delete(id);
  return FORMAT_FILTER_OPTIONS.filter((option) => next.has(option.id)).map((option) => option.id);
}

/**
 * What the closed filter dropdown says: no restriction, the single chosen
 * format's name, or a count once several are ticked.
 */
export function formatFilterLabel(formats: readonly BookFormat[]): string {
  const [only] = formats;
  if (!only) return "All formats";
  if (formats.length === 1) return FORMATS[only].label;
  return `${formats.length} formats`;
}

/** "EPUB or PDF" — the empty state names what it failed to find. */
export function formatNames(formats: readonly BookFormat[]): string {
  return formats.map((format) => FORMATS[format].label).join(" or ");
}
