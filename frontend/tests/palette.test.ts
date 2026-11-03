import { describe, expect, it } from "vite-plus/test";

import { buildPaletteResults, rankCollections } from "@/components/search/palette";
import type { SearchHit } from "@/types/domain";
import { makeCollection } from "./factories";

function hits(count: number): SearchHit[] {
  return Array.from({ length: count }, (_, index) => ({
    bookId: index + 1,
    title: `Book ${index + 1}`,
    author: null,
    snippet: "",
  }));
}

describe("collection ranking", () => {
  it("matches collection names case-insensitively", () => {
    const collections = [
      makeCollection({ id: 1, name: "Favorites" }),
      makeCollection({ id: 2, name: "Research" }),
    ];

    expect(rankCollections(collections, "FAV")).toEqual([collections[0]]);
    expect(rankCollections(collections, "search")).toEqual([collections[1]]);
    expect(rankCollections(collections, "zzz")).toEqual([]);
  });

  it("sorts exact, then prefix, then substring matches", () => {
    const collections = [
      makeCollection({ id: 1, name: "Modern Art" }),
      makeCollection({ id: 2, name: "Art of War" }),
      makeCollection({ id: 3, name: "Art" }),
    ];

    expect(rankCollections(collections, "art").map((collection) => collection.name)).toEqual([
      "Art",
      "Art of War",
      "Modern Art",
    ]);
  });

  it("keeps the loaded order when matches rank the same", () => {
    const collections = [
      makeCollection({ id: 1, name: "Art Two" }),
      makeCollection({ id: 2, name: "Art One" }),
    ];

    expect(rankCollections(collections, "art").map((collection) => collection.name)).toEqual([
      "Art Two",
      "Art One",
    ]);
  });

  it("caps collection matches at three", () => {
    const collections = [
      makeCollection({ id: 1, name: "Art One" }),
      makeCollection({ id: 2, name: "Art Two" }),
      makeCollection({ id: 3, name: "Art Three" }),
      makeCollection({ id: 4, name: "Art Four" }),
    ];

    expect(rankCollections(collections, "art")).toHaveLength(3);
  });

  it("returns nothing for a blank query", () => {
    expect(rankCollections([makeCollection()], "   ")).toEqual([]);
  });
});

describe("palette result grouping", () => {
  it("puts collections before books and fills the remaining slots with books", () => {
    const collections = [
      makeCollection({ id: 1, name: "Modern Art" }),
      makeCollection({ id: 2, name: "Art of War" }),
      makeCollection({ id: 3, name: "Art" }),
    ];

    const groups = buildPaletteResults(collections, hits(10), "art");

    expect(groups.collections.map((collection) => collection.name)).toEqual([
      "Art",
      "Art of War",
      "Modern Art",
    ]);
    expect(groups.books).toHaveLength(5);
    expect(groups.items.map((item) => item.kind)).toEqual([
      "collection",
      "collection",
      "collection",
      "book",
      "book",
      "book",
      "book",
      "book",
    ]);
  });

  it("gives books the full cap when no collection matches", () => {
    const groups = buildPaletteResults([makeCollection({ name: "Favorites" })], hits(10), "deep");

    expect(groups.collections).toEqual([]);
    expect(groups.books).toHaveLength(8);
    expect(groups.items).toHaveLength(8);
  });

  it("keeps up to three collections when there are no book hits", () => {
    const collections = [
      makeCollection({ id: 1, name: "Art One" }),
      makeCollection({ id: 2, name: "Art Two" }),
      makeCollection({ id: 3, name: "Art Three" }),
      makeCollection({ id: 4, name: "Art Four" }),
    ];

    const groups = buildPaletteResults(collections, [], "art");

    expect(groups.collections).toHaveLength(3);
    expect(groups.books).toEqual([]);
    expect(groups.items).toHaveLength(3);
  });
});
