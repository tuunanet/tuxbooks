import type { CollectionSummary, SearchHit } from "@/types/domain";

/** Total rows the palette shows across both groups. */
export const MAX_PALETTE_RESULTS = 8;
/** Collection rows the palette shows before books take the rest. */
export const MAX_COLLECTION_RESULTS = 3;

export type PaletteItem =
  | { kind: "collection"; collection: CollectionSummary }
  | { kind: "book"; hit: SearchHit };

export interface PaletteGroups {
  collections: CollectionSummary[];
  books: SearchHit[];
  /** Both groups flattened in display order, for one keyboard highlight. */
  items: PaletteItem[];
}

/** Match strength: exact name, then prefix, then anywhere in the name. */
function collectionRank(name: string, needle: string): number {
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  return name.includes(needle) ? 2 : -1;
}

/**
 * Collection matches over the loaded summaries. Case-insensitive; exact
 * names sort first, then prefixes, then substrings. Ties keep the loaded
 * order, and the group is capped at three.
 */
export function rankCollections(
  collections: readonly CollectionSummary[],
  query: string,
  limit = MAX_COLLECTION_RESULTS,
): CollectionSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [];

  const matched: { collection: CollectionSummary; rank: number; index: number }[] = [];
  collections.forEach((collection, index) => {
    const rank = collectionRank(collection.name.toLocaleLowerCase(), needle);
    if (rank >= 0) matched.push({ collection, rank, index });
  });

  return matched
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.collection);
}

/**
 * Shapes one palette response: the collection group first, then the backend
 * book hits in their relevance order filling the remaining slots up to eight.
 */
export function buildPaletteResults(
  collections: readonly CollectionSummary[],
  hits: readonly SearchHit[],
  query: string,
): PaletteGroups {
  const matchedCollections = rankCollections(collections, query);
  const remaining = Math.max(0, MAX_PALETTE_RESULTS - matchedCollections.length);
  const books = hits.slice(0, remaining);
  return {
    collections: matchedCollections,
    books,
    items: [
      ...matchedCollections.map((collection): PaletteItem => ({ kind: "collection", collection })),
      ...books.map((hit): PaletteItem => ({ kind: "book", hit })),
    ],
  };
}
