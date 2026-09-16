import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BookDetail } from "@/components/books/BookDetail";
import { BookCard } from "@/components/books/BookCard";
import { BookCover } from "@/components/books/BookCover";
import { GlobalSearch } from "@/components/search/GlobalSearch";
import { Sidebar } from "@/components/layout/Sidebar";
import { ReaderAnnotationList } from "@/components/reader/ReaderAnnotationTabs";
import { SelectionToolbar } from "@/components/reader/SelectionToolbar";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { initialAppState } from "@/state/appState";
import { coverFileUrl } from "@/lib/bridge";
import { makeAnnotation, makeBook, makeCollection } from "../factories";
import { mockInvoke } from "../mocks/bridge";

/**
 * M-1/M-2 (issue #86): publication-derived and user-stored strings are
 * untrusted. Every render surface below is attacked with hostile strings
 * (inline handlers, script tags, `javascript:` URLs, oversized values) and
 * must keep rendering them as inert React text — no element injection, no
 * script scheme in a URL sink, no unvalidated style value.
 */

const IMG_PAYLOAD = "<img src=x onerror=window.__pwned=1>";
const SCRIPT_PAYLOAD = "<script>window.__pwned=1</script>";
const JS_URL = "javascript:window.__pwned=1";
/** 200 KiB of markup-ish filler: oversized but fast to render. */
const OVERSIZED = `<b>${"A".repeat(200 * 1024)}</b>`;

/** No element from the payload may exist anywhere in the rendered tree. */
function expectNoInjectedElements(container: HTMLElement): void {
  expect(container.querySelector("script, iframe, object, embed")).toBeNull();
  expect(container.querySelector("img[src='x']")).toBeNull();
}

describe("coverFileUrl (the src sink for stored cover paths)", () => {
  it("never emits a script scheme, whatever the stored path holds", () => {
    for (const hostile of [
      JS_URL,
      "data:text/html,<script>alert(1)</script>",
      'x"><img src=x onerror=alert(1)>',
    ]) {
      const url = coverFileUrl(hostile);
      expect(url.startsWith("tuxbooks://cover/")).toBe(true);
      expect(url.toLowerCase()).not.toContain("javascript:");
      expect(url.toLowerCase()).not.toContain("data:text/html");
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("tuxbooks:");
    }
  });

  it("collapses traversal attempts to a plain cache file name", () => {
    expect(coverFileUrl("/artwork/../../etc/passwd.png")).toBe("tuxbooks://cover/passwd.png");
    expect(coverFileUrl("C:\\covers\\..\\..\\secret.png")).toBe("tuxbooks://cover/secret.png");
  });
});

describe("BookCover", () => {
  it("renders a hostile cover path only through the sanitized protocol URL", () => {
    const { container } = render(
      <BookCover book={makeBook({ coverPath: `x"><img src=x onerror=alert(1)>` })} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", coverFileUrl(`x"><img src=x onerror=alert(1)>`));
    expectNoInjectedElements(container);
  });

  it("keeps a hostile title an inert text node when no cover exists", () => {
    const { container } = render(
      <BookCover book={makeBook({ coverPath: null, title: IMG_PAYLOAD })} />,
    );
    expectNoInjectedElements(container);
    // The no-cover fallback shows the title's initial only, as text.
    expect(container.textContent).toBe("<");
  });
});

describe("BookDetail (metadata panel surface)", () => {
  function renderDetail(overrides: Partial<ReturnType<typeof makeBook>>) {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook(overrides)],
    });
    return render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: initialAppState.section,
          selectedBookId: 1,
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );
  }

  it("renders hostile title, author, and description as text nodes", async () => {
    const { container } = renderDetail({
      title: IMG_PAYLOAD,
      author: SCRIPT_PAYLOAD,
      description: IMG_PAYLOAD,
      coverPath: null,
    });
    await screen.findByTestId("detail-title");
    expectNoInjectedElements(container);
    expect(container.textContent).toContain(IMG_PAYLOAD);
    expect(container.textContent).toContain(SCRIPT_PAYLOAD);
    expect(container.innerHTML).not.toContain("<img src=x");
    expect(container.innerHTML).not.toContain("<script>");
  });

  it("renders an oversized description without breaking the page", async () => {
    const { container } = renderDetail({
      description: OVERSIZED,
      coverPath: null,
    });
    await screen.findByTestId("detail-title");
    expectNoInjectedElements(container);
    expect(container.textContent!.length).toBeGreaterThanOrEqual(OVERSIZED.length);
  });
});

describe("BookCard", () => {
  it("renders hostile title and author as inert text", () => {
    const { container } = render(
      <BookCard
        book={makeBook({ title: IMG_PAYLOAD, author: SCRIPT_PAYLOAD, coverPath: null })}
        collections={[]}
      />,
    );
    expectNoInjectedElements(container);
    expect(container.textContent).toContain(IMG_PAYLOAD);
    expect(container.textContent).toContain(SCRIPT_PAYLOAD);
  });
});

describe("GlobalSearch (search-result and snippet interpolation)", () => {
  it("renders a marker-breakout snippet as escaped text, not markup", async () => {
    // FTS5 markers injected by hostile stored text: the img tag lands
    // outside the marker pair and must still stay a text node.
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook({ title: IMG_PAYLOAD })],
      search_books: [
        {
          bookId: 1,
          title: IMG_PAYLOAD,
          author: SCRIPT_PAYLOAD,
          snippet: `normal <em></em>${IMG_PAYLOAD}<em>tail`,
        },
      ],
    });
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <GlobalSearch />
        </LibraryDataProvider>
      </AppStateProvider>,
    );
    await userEvent.type(screen.getByTestId("global-search"), "deep");
    const snippets = await screen.findAllByTestId("global-search-snippet");
    expectNoInjectedElements(snippets[0]!.closest("[role='listbox']") as HTMLElement);
    expectNoInjectedElements(document.body);
  });
});

describe("ReaderAnnotationList (stored annotation strings)", () => {
  const noop = vi.fn();

  it("renders hostile note, text, and locator strings as text nodes", () => {
    const { container } = render(
      <ReaderAnnotationList
        annotations={[
          makeAnnotation({
            note: IMG_PAYLOAD,
            text: SCRIPT_PAYLOAD,
            chapterHref: JS_URL,
            color: "red; background:url(https://evil.example/x)",
          }),
        ]}
        withColor
        label={(annotation) => annotation.chapterHref ?? "Highlight"}
        onJump={noop}
        onDelete={noop}
        onUpdate={noop}
        testIdPrefix="hostile-annotation"
      />,
    );
    expectNoInjectedElements(container);
    expect(container.textContent).toContain(IMG_PAYLOAD);
    expect(container.textContent).toContain(SCRIPT_PAYLOAD);
    expect(container.textContent).toContain(JS_URL);
  });

  it("clamps a hostile stored color to the highlight palette", () => {
    const { container } = render(
      <ReaderAnnotationList
        annotations={[
          makeAnnotation({
            color: "red; background:url(https://evil.example/x)",
          }),
        ]}
        withColor
        label={() => "Page 2"}
        onJump={noop}
        onDelete={noop}
        onUpdate={noop}
        testIdPrefix="hostile-color"
      />,
    );
    const dot = container.querySelector<HTMLElement>(`[data-testid="hostile-color-color-0"]`);
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("style")).toBe("background: rgb(250, 204, 21);");
  });
});

describe("SelectionToolbar (live publication selection)", () => {
  it("renders the selected text as an inert text node", () => {
    const { container } = render(
      <SelectionToolbar
        selection={{ text: `${IMG_PAYLOAD}${SCRIPT_PAYLOAD}`, highlightId: null }}
        onAction={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expectNoInjectedElements(container);
    expect(container.textContent).toContain(IMG_PAYLOAD);
  });
});

describe("Sidebar (user-stored collection names)", () => {
  function renderSidebar(collections: unknown[]) {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: collections.length },
      list_books: [],
      list_collections: collections,
    });
    return render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar active={initialAppState.section} onSectionChange={vi.fn()} />
        </LibraryDataProvider>
      </AppStateProvider>,
    );
  }

  it("renders a hostile collection name as inert text, also in the tooltip", async () => {
    const { container } = renderSidebar([makeCollection({ name: IMG_PAYLOAD })]);
    expect(await screen.findByText(IMG_PAYLOAD)).toBeInTheDocument();
    expectNoInjectedElements(container);
    // The tooltip is an escaped attribute, never markup.
    const button = container.querySelector(`[title*="Delete"]`);
    expect(button).not.toBeNull();
    expect(button!.getAttribute("title")).toContain(IMG_PAYLOAD);
  });
});
