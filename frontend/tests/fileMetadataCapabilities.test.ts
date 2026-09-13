import { describe, expect, it } from "vitest";

import { isFileWritable, type MetadataFieldKey } from "@/lib/fileMetadataCapabilities";

const ALL_FIELDS: MetadataFieldKey[] = [
  "title",
  "subtitle",
  "authors",
  "publisher",
  "language",
  "isbn",
  "publicationDate",
  "series",
  "seriesIndex",
  "subjects",
  "description",
];

describe("fileMetadataCapabilities", () => {
  it("lets EPUB store every supported field", () => {
    for (const field of ALL_FIELDS) {
      expect(isFileWritable("epub", field)).toBe(true);
    }
  });

  it("limits PDF to title, authors, and description", () => {
    for (const field of ["title", "authors", "description"] as const) {
      expect(isFileWritable("pdf", field)).toBe(true);
    }
    for (const field of ALL_FIELDS.filter(
      (field) => !["title", "authors", "description"].includes(field),
    )) {
      expect(isFileWritable("pdf", field)).toBe(false);
    }
  });
});
