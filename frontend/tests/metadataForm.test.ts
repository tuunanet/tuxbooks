import { describe, expect, it } from "vitest";

import { fromForm, toForm } from "@/components/books/metadata/metadataForm";
import type { MetadataFields } from "@/types/domain";

const fields: MetadataFields = {
  title: "A Minimal Book",
  subtitle: "A Subtitle",
  publisher: "Tuxbooks Press",
  language: "en",
  isbn: null,
  description: "A tiny EPUB used as a test fixture.",
  publicationDate: "1843",
  series: "Analytical Engines",
  seriesIndex: 2,
  authors: ["Ada Lovelace", "Charles Babbage"],
  subjects: ["Computing"],
};

describe("metadataForm", () => {
  it("mirrors MetadataFields into the editable form", () => {
    expect(toForm(fields)).toEqual({
      title: "A Minimal Book",
      subtitle: "A Subtitle",
      authors: ["Ada Lovelace", "Charles Babbage"],
      subjects: ["Computing"],
      publisher: "Tuxbooks Press",
      language: "en",
      isbn: "",
      publicationDate: "1843",
      series: "Analytical Engines",
      seriesIndex: "2",
      description: "A tiny EPUB used as a test fixture.",
    });
  });

  it("renders a null series index as an empty string", () => {
    expect(toForm({ ...fields, seriesIndex: null }).seriesIndex).toBe("");
  });

  it("parses empty fields to null and trims/de-duplicates lists", () => {
    const form = toForm(fields);
    const parsed = fromForm({
      ...form,
      subtitle: "  ",
      authors: [" Ada Lovelace ", "Grace Hopper", "Ada Lovelace"],
      subjects: [""],
      seriesIndex: "2.5",
    });
    expect(parsed).toMatchObject({
      subtitle: null,
      authors: ["Ada Lovelace", "Grace Hopper"],
      subjects: [],
      seriesIndex: 2.5,
    });
  });

  it("drops a blank or non-finite series index", () => {
    const form = toForm(fields);
    expect(fromForm({ ...form, seriesIndex: "" }).seriesIndex).toBeNull();
    expect(fromForm({ ...form, seriesIndex: "abc" }).seriesIndex).toBeNull();
  });

  it("round-trips through the form representation", () => {
    expect(fromForm(toForm(fields))).toEqual(fields);
  });
});
