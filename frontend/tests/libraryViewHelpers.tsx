import { render } from "@testing-library/react";
import { LibraryView } from "@/components/library/LibraryView";
import { AppShell } from "@/components/layout/AppShell";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import type { LibrarySection } from "@/state/appState";
import { makeBook } from "./factories";

export function renderLibrary(section: LibrarySection = { kind: "smart", id: "all-books" }) {
  return render(
    <AppStateProvider>
      <LibraryDataProvider>
        <ImportProvider>
          <LibraryView section={section} />
        </ImportProvider>
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

/** Full shell: needed when the test asserts view changes (detail/reader). */
export function renderShell(section: LibrarySection = { kind: "smart", id: "all-books" }) {
  return render(
    <AppShell
      initialState={{
        view: "library",
        section,
        selectedBookId: null,
        libraryQuery: "",
      }}
    />,
  );
}

export const alpha = () =>
  makeBook({ id: 1, title: "Alpha", author: "Zed Author", addedAt: "2026-01-01T00:00:00.000Z" });
export const beta = () =>
  makeBook({
    id: 2,
    title: "Beta",
    author: "Yuki Author",
    addedAt: "2026-02-01T00:00:00.000Z",
  });

/** Indexes with a runtime guard so `noUncheckedIndexedAccess` stays honest. */
export function item<T>(items: T[], index: number): T {
  const value = items.at(index);
  if (value === undefined) throw new Error(`expected an item at index ${index}`);
  return value;
}
