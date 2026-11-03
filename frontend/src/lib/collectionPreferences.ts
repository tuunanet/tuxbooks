/**
 * Per-device sidebar collection preferences.
 *
 * The sidebar splits collections into Pinned Collections and Unpinned
 * Collections. Pin state, custom order per group, and the Unpinned collapse
 * choice are device-local (localStorage), keyed by the local collection id.
 * Collection contents live in the sidecar; this module only remembers how the
 * local sidebar presents them.
 *
 * A group stays alphabetical until the user drags inside it. An empty order
 * array means alphabetical; a non-empty one is the full custom order. New
 * collections, and collections that enter a group through pin/unpin, are
 * inserted alphabetically while the group is alphabetical and appended once
 * it is custom.
 *
 * Stored state is validated on read: corrupt JSON falls back to defaults,
 * ids that no longer exist are dropped, and missing ids are appended with the
 * normal insert rule. Writing a sanitized snapshot never puts a stale id back.
 */

import type { CollectionSummary } from "@/types/domain";

export const COLLECTION_PREFERENCES_STORAGE_KEY = "tuxbooks.collectionGroups";

/** The subset of a collection the preference logic needs. */
export type CollectionRef = Pick<CollectionSummary, "id" | "name">;

export type CollectionGroupId = "pinned" | "unpinned";

export interface CollectionPreferences {
  /** Collections shown in the Pinned group. Membership, not display order. */
  pinned: number[];
  /** Custom Pinned order; empty means alphabetical. */
  pinnedOrder: number[];
  /** Custom Unpinned order; empty means alphabetical. */
  unpinnedOrder: number[];
  unpinnedCollapsed: boolean;
}

export interface CollectionGroups {
  pinned: CollectionRef[];
  unpinned: CollectionRef[];
}

export function defaultCollectionPreferences(): CollectionPreferences {
  return { pinned: [], pinnedOrder: [], unpinnedOrder: [], unpinnedCollapsed: false };
}

function alphabetical(collections: readonly CollectionRef[]): CollectionRef[] {
  return [...collections].sort((a, b) => {
    // Case-insensitive first, then the locale's own casing rule, then id so
    // two collections with the same name still have one stable order.
    const lower = a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase());
    if (lower !== 0) return lower;
    const locale = a.name.localeCompare(b.name);
    if (locale !== 0) return locale;
    return a.id - b.id;
  });
}

function readIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || seen.has(entry)) continue;
    seen.add(entry);
    ids.push(entry);
  }
  return ids;
}

/**
 * Bring a stored order back to a full order over `ids`. Any stored id that is
 * not in the group is dropped; ids the order is missing are appended
 * alphabetically. An order with no surviving entry means alphabetical mode.
 */
function sanitizeOrder(
  ids: readonly number[],
  stored: unknown,
  byId: ReadonlyMap<number, CollectionRef>,
): number[] {
  const allowed = new Set(ids);
  const ordered: number[] = [];
  const seen = new Set<number>();
  for (const id of readIdList(stored)) {
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  if (ordered.length === 0) return [];
  const missing = alphabetical(
    ids.flatMap((id) => {
      const collection = byId.get(id);
      return collection && !seen.has(id) ? [collection] : [];
    }),
  );
  return [...ordered, ...missing.map((collection) => collection.id)];
}

/** Validate raw stored state against the collections that currently exist. */
export function sanitizeCollectionPreferences(
  raw: unknown,
  collections: readonly CollectionRef[],
): CollectionPreferences {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const known = new Map(collections.map((collection) => [collection.id, collection]));
  const pinned = readIdList(source.pinned).filter((id) => known.has(id));
  const pinnedSet = new Set(pinned);
  const unpinned = collections
    .filter((collection) => !pinnedSet.has(collection.id))
    .map((c) => c.id);

  return {
    pinned,
    pinnedOrder: sanitizeOrder(pinned, source.pinnedOrder, known),
    unpinnedOrder: sanitizeOrder(unpinned, source.unpinnedOrder, known),
    unpinnedCollapsed: source.unpinnedCollapsed === true,
  };
}

function orderGroup(
  collections: readonly CollectionRef[],
  order: readonly number[],
): CollectionRef[] {
  if (order.length === 0) return alphabetical(collections);
  const byId = new Map(collections.map((collection) => [collection.id, collection]));
  const ordered = order.flatMap((id) => {
    const collection = byId.get(id);
    return collection ? [collection] : [];
  });
  const seen = new Set(ordered.map((collection) => collection.id));
  return [
    ...ordered,
    ...alphabetical(collections.filter((collection) => !seen.has(collection.id))),
  ];
}

/** The two rendered groups, every collection in exactly one of them. */
export function resolveCollectionGroups(
  collections: readonly CollectionRef[],
  preferences: CollectionPreferences,
): CollectionGroups {
  const pinnedSet = new Set(preferences.pinned);
  return {
    pinned: orderGroup(
      collections.filter((collection) => pinnedSet.has(collection.id)),
      preferences.pinnedOrder,
    ),
    unpinned: orderGroup(
      collections.filter((collection) => !pinnedSet.has(collection.id)),
      preferences.unpinnedOrder,
    ),
  };
}

/** Pin one collection, keeping alphabetical mode alphabetical and appending in custom. */
export function pinCollection(
  preferences: CollectionPreferences,
  collectionId: number,
): CollectionPreferences {
  if (preferences.pinned.includes(collectionId)) return preferences;
  return {
    ...preferences,
    pinned: [...preferences.pinned, collectionId],
    pinnedOrder:
      preferences.pinnedOrder.length > 0
        ? [...preferences.pinnedOrder, collectionId]
        : preferences.pinnedOrder,
    unpinnedOrder: preferences.unpinnedOrder.filter((id) => id !== collectionId),
  };
}

/** Unpin one collection with the same insert-or-append rule in Unpinned. */
export function unpinCollection(
  preferences: CollectionPreferences,
  collectionId: number,
): CollectionPreferences {
  if (!preferences.pinned.includes(collectionId)) return preferences;
  return {
    ...preferences,
    pinned: preferences.pinned.filter((id) => id !== collectionId),
    pinnedOrder: preferences.pinnedOrder.filter((id) => id !== collectionId),
    unpinnedOrder:
      preferences.unpinnedOrder.length > 0
        ? [...preferences.unpinnedOrder.filter((id) => id !== collectionId), collectionId]
        : preferences.unpinnedOrder,
  };
}

/** Write a full explicit order for one group, switching it to custom. */
function setGroupOrder(
  preferences: CollectionPreferences,
  group: CollectionGroupId,
  order: readonly number[],
): CollectionPreferences {
  return group === "pinned"
    ? { ...preferences, pinnedOrder: [...order] }
    : { ...preferences, unpinnedOrder: [...order] };
}

/**
 * Keyboard move: swap with the neighbour inside the current group and keep
 * that group custom. At the edges this is a no-op.
 */
export function moveCollection(
  preferences: CollectionPreferences,
  collections: readonly CollectionRef[],
  collectionId: number,
  direction: -1 | 1,
): CollectionPreferences {
  const groups = resolveCollectionGroups(collections, preferences);
  const pinned = preferences.pinned.includes(collectionId);
  const group = pinned ? groups.pinned : groups.unpinned;
  const index = group.findIndex((collection) => collection.id === collectionId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= group.length) return preferences;

  const reordered = [...group];
  const current = reordered[index];
  const neighbour = reordered[target];
  if (!current || !neighbour) return preferences;
  reordered[index] = neighbour;
  reordered[target] = current;
  return setGroupOrder(
    preferences,
    pinned ? "pinned" : "unpinned",
    reordered.map((collection) => collection.id),
  );
}

/**
 * Drag/drop: place one collection at `index` in the target group. Crossing
 * the boundary changes pin state, and the target group becomes custom. The
 * source group only loses the id from its custom order; if it was
 * alphabetical it stays alphabetical.
 */
export function placeCollection(
  preferences: CollectionPreferences,
  collections: readonly CollectionRef[],
  collectionId: number,
  targetGroup: CollectionGroupId,
  index: number,
): CollectionPreferences {
  const moving = collections.find((collection) => collection.id === collectionId);
  if (!moving) return preferences;

  const groups = resolveCollectionGroups(collections, preferences);
  const sourceGroup: CollectionGroupId = preferences.pinned.includes(collectionId)
    ? "pinned"
    : "unpinned";
  const targetItems = (targetGroup === "pinned" ? groups.pinned : groups.unpinned).filter(
    (collection) => collection.id !== collectionId,
  );
  const clamped = Math.max(0, Math.min(index, targetItems.length));
  targetItems.splice(clamped, 0, moving);
  const order = targetItems.map((collection) => collection.id);

  if (targetGroup === "pinned") {
    return {
      ...preferences,
      pinned: preferences.pinned.includes(collectionId)
        ? preferences.pinned
        : [...preferences.pinned, collectionId],
      pinnedOrder: order,
      unpinnedOrder:
        sourceGroup === "unpinned"
          ? preferences.unpinnedOrder.filter((id) => id !== collectionId)
          : preferences.unpinnedOrder,
    };
  }

  return {
    ...preferences,
    pinned: preferences.pinned.filter((id) => id !== collectionId),
    pinnedOrder: preferences.pinnedOrder.filter((id) => id !== collectionId),
    unpinnedOrder: order,
  };
}

export function setUnpinnedCollapsed(
  preferences: CollectionPreferences,
  collapsed: boolean,
): CollectionPreferences {
  return preferences.unpinnedCollapsed === collapsed
    ? preferences
    : { ...preferences, unpinnedCollapsed: collapsed };
}

/** Drop a deleted collection from membership and both orders. */
export function forgetCollection(
  preferences: CollectionPreferences,
  collectionId: number,
): CollectionPreferences {
  const pinned = preferences.pinned.filter((id) => id !== collectionId);
  const pinnedOrder = preferences.pinnedOrder.filter((id) => id !== collectionId);
  const unpinnedOrder = preferences.unpinnedOrder.filter((id) => id !== collectionId);
  if (
    pinned.length === preferences.pinned.length &&
    pinnedOrder.length === preferences.pinnedOrder.length &&
    unpinnedOrder.length === preferences.unpinnedOrder.length
  ) {
    return preferences;
  }
  return { ...preferences, pinned, pinnedOrder, unpinnedOrder };
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Raw snapshot read by `useSyncExternalStore`; a string keeps it value-stable. */
export function readCollectionPreferencesRaw(): string | null {
  // A session fallback wins while it exists: storage may be full or absent,
  // and the latest choice must not vanish behind an older stored value.
  if (sessionRaw !== undefined) return sessionRaw;
  const storage = safeStorage();
  if (!storage) return null;
  try {
    return storage.getItem(COLLECTION_PREFERENCES_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function parseStoredCollectionPreferences(
  raw: string | null,
  collections: readonly CollectionRef[],
): CollectionPreferences {
  if (!raw) return defaultCollectionPreferences();
  try {
    return sanitizeCollectionPreferences(JSON.parse(raw), collections);
  } catch {
    return defaultCollectionPreferences();
  }
}

/** Read and sanitize the current device's preferences. */
export function readCollectionPreferences(
  collections: readonly CollectionRef[],
): CollectionPreferences {
  return parseStoredCollectionPreferences(readCollectionPreferencesRaw(), collections);
}

const listeners = new Set<() => void>();
/** Session fallback for unavailable or full storage. */
let sessionRaw: string | null | undefined;

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeCollectionPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function writeCollectionPreferences(preferences: CollectionPreferences): void {
  const raw = JSON.stringify(preferences);
  const storage = safeStorage();
  if (storage) {
    try {
      storage.setItem(COLLECTION_PREFERENCES_STORAGE_KEY, raw);
      sessionRaw = undefined;
      emit();
      return;
    } catch {
      // Storage full: keep the choice for this session instead of failing.
    }
  }
  sessionRaw = raw;
  emit();
}
