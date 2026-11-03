import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  COLLECTION_PREFERENCES_STORAGE_KEY,
  defaultCollectionPreferences,
  forgetCollection,
  moveCollection,
  parseStoredCollectionPreferences,
  pinCollection,
  placeCollection,
  readCollectionPreferencesRaw,
  resolveCollectionGroups,
  sanitizeCollectionPreferences,
  setUnpinnedCollapsed,
  unpinCollection,
  writeCollectionPreferences,
  type CollectionPreferences,
  type CollectionRef,
} from "@/lib/collectionPreferences";
import { makeCollection } from "./factories";

const collections = [
  makeCollection({ id: 1, name: "Zebra" }),
  makeCollection({ id: 2, name: "alpha" }),
  makeCollection({ id: 3, name: "Beta" }),
];

function names(items: readonly { name: string }[]): string[] {
  return items.map((collection) => collection.name);
}

function readPreferences(collections: readonly CollectionRef[]): CollectionPreferences {
  return parseStoredCollectionPreferences(readCollectionPreferencesRaw(), collections);
}

function withPrefs(overrides: Partial<CollectionPreferences>): CollectionPreferences {
  return { ...defaultCollectionPreferences(), ...overrides };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("collection preferences", () => {
  it("starts with every collection unpinned and alphabetical", () => {
    expect(defaultCollectionPreferences()).toEqual({
      pinned: [],
      pinnedOrder: [],
      unpinnedOrder: [],
      unpinnedCollapsed: false,
    });

    const groups = resolveCollectionGroups(collections, defaultCollectionPreferences());
    expect(names(groups.pinned)).toEqual([]);
    expect(names(groups.unpinned)).toEqual(["alpha", "Beta", "Zebra"]);
  });

  it("sorts case-insensitively, then by locale, so casing never changes position", () => {
    const mixed = [
      makeCollection({ id: 10, name: "Alpha" }),
      makeCollection({ id: 11, name: "beta" }),
      makeCollection({ id: 12, name: "alpha" }),
    ];
    const groups = resolveCollectionGroups(mixed, defaultCollectionPreferences());
    expect(names(groups.unpinned)).toEqual(["alpha", "Alpha", "beta"]);
  });

  it("keeps pinned collections above unpinned ones", () => {
    const groups = resolveCollectionGroups(collections, withPrefs({ pinned: [2] }));
    expect(names(groups.pinned)).toEqual(["alpha"]);
    expect(names(groups.unpinned)).toEqual(["Beta", "Zebra"]);
  });

  it("uses a custom pinned order without disturbing the alphabetical unpinned group", () => {
    const groups = resolveCollectionGroups(
      collections,
      withPrefs({ pinned: [1, 3], pinnedOrder: [1, 3] }),
    );
    expect(names(groups.pinned)).toEqual(["Zebra", "Beta"]);
    expect(names(groups.unpinned)).toEqual(["alpha"]);
  });

  it("uses a custom unpinned order without disturbing the alphabetical pinned group", () => {
    const groups = resolveCollectionGroups(
      collections,
      withPrefs({ pinned: [2], unpinnedOrder: [1, 3] }),
    );
    expect(names(groups.pinned)).toEqual(["alpha"]);
    expect(names(groups.unpinned)).toEqual(["Zebra", "Beta"]);
  });
});

describe("pin and unpin placement", () => {
  it("inserts a newly pinned collection alphabetically while Pinned is alphabetical", () => {
    const prefs = pinCollection(withPrefs({ pinned: [2] }), 3);
    const groups = resolveCollectionGroups(collections, prefs);
    // Beta belongs between alpha and Zebra, regardless of which order it was
    // pinned in.
    expect(names(groups.pinned)).toEqual(["alpha", "Beta"]);
    expect(names(groups.unpinned)).toEqual(["Zebra"]);
  });

  it("appends a newly pinned collection once Pinned is custom", () => {
    const prefs = pinCollection(withPrefs({ pinned: [1, 3], pinnedOrder: [3, 1] }), 2);
    const groups = resolveCollectionGroups(collections, prefs);
    expect(names(groups.pinned)).toEqual(["Beta", "Zebra", "alpha"]);
  });

  it("inserts a newly unpinned collection alphabetically while Unpinned is alphabetical", () => {
    const prefs = unpinCollection(withPrefs({ pinned: [2], pinnedOrder: [2] }), 2);
    const groups = resolveCollectionGroups(collections, prefs);
    expect(names(groups.pinned)).toEqual([]);
    expect(names(groups.unpinned)).toEqual(["alpha", "Beta", "Zebra"]);
  });

  it("appends a newly unpinned collection once Unpinned is custom", () => {
    const prefs = unpinCollection(
      withPrefs({ pinned: [2], pinnedOrder: [2], unpinnedOrder: [1, 3] }),
      2,
    );
    const groups = resolveCollectionGroups(collections, prefs);
    expect(names(groups.unpinned)).toEqual(["Zebra", "Beta", "alpha"]);
  });

  it("removes a pinned id from the unpinned custom order when pinning", () => {
    const prefs = pinCollection(withPrefs({ unpinnedOrder: [1, 2, 3] }), 2);
    expect(prefs.unpinnedOrder).toEqual([1, 3]);
    expect(prefs.pinned).toEqual([2]);
    expect(prefs.pinnedOrder).toEqual([]);
  });

  it("leaves the pinned order alone when unpinning from an alphabetical Pinned group", () => {
    const prefs = unpinCollection(withPrefs({ pinned: [1, 2] }), 2);
    expect(prefs.pinned).toEqual([1]);
    expect(prefs.pinnedOrder).toEqual([]);
    expect(prefs.unpinnedOrder).toEqual([]);
  });
});

describe("ordering actions", () => {
  it("moves a collection within its group and switches only that group to custom", () => {
    const prefs = moveCollection(defaultCollectionPreferences(), collections, 2, 1);
    const groups = resolveCollectionGroups(collections, prefs);

    expect(names(groups.pinned)).toEqual([]);
    expect(names(groups.unpinned)).toEqual(["Beta", "alpha", "Zebra"]);
    expect(prefs.unpinnedOrder).toEqual([3, 2, 1]);
    expect(prefs.pinnedOrder).toEqual([]);
  });

  it("moves a pinned collection without switching Unpinned to custom", () => {
    const prefs = moveCollection(withPrefs({ pinned: [1, 2] }), collections, 2, 1);
    const groups = resolveCollectionGroups(collections, prefs);

    expect(names(groups.pinned)).toEqual(["Zebra", "alpha"]);
    expect(names(groups.unpinned)).toEqual(["Beta"]);
    expect(prefs.pinnedOrder).toEqual([1, 2]);
    expect(prefs.unpinnedOrder).toEqual([]);
  });

  it("does nothing at the top or bottom edge of a group", () => {
    const prefs = defaultCollectionPreferences();
    expect(moveCollection(prefs, collections, 2, -1)).toBe(prefs);
    expect(moveCollection(prefs, collections, 1, 1)).toBe(prefs);
  });

  it("pins a row when dropped into Pinned", () => {
    const prefs = placeCollection(withPrefs({ pinned: [1] }), collections, 2, "pinned", 0);
    const groups = resolveCollectionGroups(collections, prefs);

    expect(names(groups.pinned)).toEqual(["alpha", "Zebra"]);
    expect(names(groups.unpinned)).toEqual(["Beta"]);
    expect(prefs.pinned).toEqual([1, 2]);
    expect(prefs.pinnedOrder).toEqual([2, 1]);
  });

  it("unpins a row when dropped into Unpinned", () => {
    const prefs = placeCollection(
      withPrefs({ pinned: [1, 2], pinnedOrder: [1, 2] }),
      collections,
      1,
      "unpinned",
      1,
    );
    const groups = resolveCollectionGroups(collections, prefs);

    expect(names(groups.pinned)).toEqual(["alpha"]);
    expect(names(groups.unpinned)).toEqual(["Beta", "Zebra"]);
    expect(prefs.pinnedOrder).toEqual([2]);
    expect(prefs.unpinnedOrder).toEqual([3, 1]);
  });

  it("places a row at a gap inside its own group", () => {
    // Unpinned starts alpha, Beta, Zebra. Dropping alpha in the gap after
    // Beta inserts it at index 1 of the other rows and makes the group custom.
    const prefs = placeCollection(defaultCollectionPreferences(), collections, 2, "unpinned", 1);
    const groups = resolveCollectionGroups(collections, prefs);

    expect(names(groups.unpinned)).toEqual(["Beta", "alpha", "Zebra"]);
    expect(prefs.unpinnedOrder).toEqual([3, 2, 1]);
    expect(prefs.pinnedOrder).toEqual([]);
  });

  it("clamps a drop past the end of the target group", () => {
    const prefs = placeCollection(withPrefs({ pinned: [1] }), collections, 2, "pinned", 99);
    const groups = resolveCollectionGroups(collections, prefs);
    expect(names(groups.pinned)).toEqual(["Zebra", "alpha"]);
  });
});

describe("collapse", () => {
  it("stores the collapse choice and only accepts a literal true", () => {
    const collapsed = setUnpinnedCollapsed(defaultCollectionPreferences(), true);
    expect(collapsed.unpinnedCollapsed).toBe(true);
    writeCollectionPreferences(collapsed);
    expect(readPreferences(collections).unpinnedCollapsed).toBe(true);

    expect(
      sanitizeCollectionPreferences({ unpinnedCollapsed: "yes" }, collections).unpinnedCollapsed,
    ).toBe(false);
  });
});

describe("storage sanitation", () => {
  it("falls back to defaults on corrupt JSON", () => {
    window.localStorage.setItem(COLLECTION_PREFERENCES_STORAGE_KEY, "{ not json");
    expect(readPreferences(collections)).toEqual(defaultCollectionPreferences());
  });

  it("drops stale ids and appends missing ids with the normal insert rule", () => {
    window.localStorage.setItem(
      COLLECTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        pinned: [99, 3],
        pinnedOrder: [99, 3],
        unpinnedOrder: [98, 1],
        unpinnedCollapsed: false,
      }),
    );

    const prefs = readPreferences(collections);
    // 99 is gone; 3 (Beta) stays pinned. Unpinned holds Zebra (1) and alpha
    // (2); the stored custom order starts with Zebra, so alpha appends.
    expect(prefs.pinned).toEqual([3]);
    expect(prefs.pinnedOrder).toEqual([3]);
    expect(prefs.unpinnedOrder).toEqual([1, 2]);
    expect(names(resolveCollectionGroups(collections, prefs).pinned)).toEqual(["Beta"]);
    expect(names(resolveCollectionGroups(collections, prefs).unpinned)).toEqual(["Zebra", "alpha"]);
  });

  it("appends a newly added collection to the end of a custom group", () => {
    const four = [...collections, makeCollection({ id: 4, name: "Aardvark" })];
    const prefs = sanitizeCollectionPreferences({ unpinnedOrder: [1, 2, 3] }, four);
    expect(prefs.unpinnedOrder).toEqual([1, 2, 3, 4]);
    expect(names(resolveCollectionGroups(four, prefs).unpinned)).toEqual([
      "Zebra",
      "alpha",
      "Beta",
      "Aardvark",
    ]);
  });

  it("inserts a new collection alphabetically while the group is alphabetical", () => {
    const four = [...collections, makeCollection({ id: 4, name: "Aardvark" })];
    const prefs = sanitizeCollectionPreferences({}, four);
    expect(prefs.unpinnedOrder).toEqual([]);
    expect(names(resolveCollectionGroups(four, prefs).unpinned)).toEqual([
      "Aardvark",
      "alpha",
      "Beta",
      "Zebra",
    ]);
  });

  it("never writes stale ids back after reading a sanitized snapshot", () => {
    window.localStorage.setItem(
      COLLECTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ pinned: [99], pinnedOrder: [99], unpinnedOrder: [98] }),
    );

    writeCollectionPreferences(readPreferences(collections));
    const raw = window.localStorage.getItem(COLLECTION_PREFERENCES_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("99");
    expect(raw).not.toContain("98");
  });

  it("ignores malformed fields instead of trusting them", () => {
    const prefs = sanitizeCollectionPreferences(
      {
        pinned: "yes",
        pinnedOrder: { id: 1 },
        unpinnedOrder: [1, "2", null, 1],
        unpinnedCollapsed: 1,
      },
      collections,
    );
    expect(prefs).toEqual(withPrefs({ unpinnedOrder: [1, 2, 3] }));
  });

  it("drops a deleted collection from membership and both orders", () => {
    const prefs = forgetCollection(
      withPrefs({ pinned: [2], pinnedOrder: [2], unpinnedOrder: [1, 3] }),
      2,
    );
    expect(prefs).toEqual(withPrefs({ unpinnedOrder: [1, 3] }));
  });

  it("round-trips a complete custom state", () => {
    const stored = withPrefs({
      pinned: [3, 1],
      pinnedOrder: [1, 3],
      unpinnedOrder: [2],
      unpinnedCollapsed: true,
    });
    writeCollectionPreferences(stored);
    expect(readPreferences(collections)).toEqual(stored);
  });

  it("sanitizes on read even when the stored object is a non-object", () => {
    expect(parseStoredCollectionPreferences("null", collections)).toEqual(
      defaultCollectionPreferences(),
    );
    expect(parseStoredCollectionPreferences("42", collections)).toEqual(
      defaultCollectionPreferences(),
    );
  });
});
