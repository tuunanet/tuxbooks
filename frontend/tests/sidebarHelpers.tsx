import { render, within } from "@testing-library/react";
import { vi } from "vite-plus/test";

import { Sidebar } from "@/components/layout/Sidebar";
import {
  COLLECTION_PREFERENCES_STORAGE_KEY,
  defaultCollectionPreferences,
  type CollectionPreferences,
} from "@/lib/collectionPreferences";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { initialAppState, type CollectionSelectMode, type LibrarySection } from "@/state/appState";
import type { CollectionSummary } from "@/types/domain";
import { mockInvoke } from "./mocks/bridge";

export { COLLECTION_PREFERENCES_STORAGE_KEY };
export type { CollectionPreferences };

export function renderSidebar(
  onSectionChange: (section: LibrarySection) => void,
  onOpenSettings: () => void = vi.fn(),
  onCollectionSelect: (
    collectionId: number,
    mode: CollectionSelectMode,
    visibleIds: number[],
  ) => void = vi.fn(),
) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
    list_collections: [],
  });
  return render(
    <AppStateProvider>
      <LibraryDataProvider>
        <Sidebar
          active={initialAppState.section}
          onSectionChange={onSectionChange}
          onCollectionSelect={onCollectionSelect}
          onCollectionDeleted={vi.fn()}
          onOpenSettings={onOpenSettings}
        />
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

export function seedCollectionPreferences(overrides: Partial<CollectionPreferences> = {}) {
  window.localStorage.setItem(
    COLLECTION_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ ...defaultCollectionPreferences(), ...overrides }),
  );
}

export function collectionNames(group: HTMLElement): (string | null)[] {
  return within(group)
    .getAllByTestId("collection-item")
    .map((item) => item.textContent);
}

export function collectionRow(collectionId: number): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-collection-row="${collectionId}"]`);
  if (!row) throw new Error(`collection row ${collectionId} is not rendered`);
  return row;
}

/** jsdom has no elementFromPoint; the drag wiring asks it what is under the pointer. */
export function stubElementFromPoint(element: HTMLElement): () => void {
  const doc = document as Document & {
    elementFromPoint?: (x: number, y: number) => Element | null;
  };
  const original = doc.elementFromPoint;
  doc.elementFromPoint = () => element;
  return () => {
    if (original) doc.elementFromPoint = original;
    else Reflect.deleteProperty(doc, "elementFromPoint");
  };
}

export function renderCollectionSidebar(
  collections: CollectionSummary[],
  {
    active = initialAppState.section,
    onSectionChange = vi.fn(),
    onCollectionSelect = vi.fn(),
    onCollectionDeleted = vi.fn(),
  }: {
    active?: LibrarySection;
    onSectionChange?: (section: LibrarySection) => void;
    onCollectionSelect?: (
      collectionId: number,
      mode: CollectionSelectMode,
      visibleIds: number[],
    ) => void;
    onCollectionDeleted?: (collectionId: number) => void;
  } = {},
) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: collections.length },
    list_books: [],
    list_collections: collections,
  });
  const view = render(
    <AppStateProvider>
      <LibraryDataProvider>
        <Sidebar
          active={active}
          onSectionChange={onSectionChange}
          onCollectionSelect={onCollectionSelect}
          onCollectionDeleted={onCollectionDeleted}
          onOpenSettings={vi.fn()}
        />
      </LibraryDataProvider>
    </AppStateProvider>,
  );
  return { ...view, onSectionChange, onCollectionSelect, onCollectionDeleted };
}
