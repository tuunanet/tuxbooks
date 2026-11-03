import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  parseStoredCollectionPreferences,
  readCollectionPreferencesRaw,
  subscribeCollectionPreferences,
  writeCollectionPreferences,
  type CollectionPreferences,
  type CollectionRef,
} from "@/lib/collectionPreferences";

/**
 * The sidebar's device-local collection preferences. `collections` only
 * shapes the sanitized snapshot (alphabetical order and stale-id cleanup);
 * the stored state itself never leaves this device.
 */
export function useCollectionPreferences(collections: readonly CollectionRef[]) {
  const raw = useSyncExternalStore(
    subscribeCollectionPreferences,
    readCollectionPreferencesRaw,
    readCollectionPreferencesRaw,
  );
  const preferences = useMemo(
    () => parseStoredCollectionPreferences(raw, collections),
    [raw, collections],
  );
  const save = useCallback((next: CollectionPreferences) => writeCollectionPreferences(next), []);
  return { preferences, save };
}
