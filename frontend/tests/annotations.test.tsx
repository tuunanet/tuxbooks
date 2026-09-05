import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useAnnotations } from "@/hooks/useAnnotations";
import {
  annotationRects,
  byKind,
  highlightCssColor,
  isBookmarkAtCfi,
  isBookmarkAtPage,
  normalizeRect,
} from "@/components/reader/annotationModel";
import { makeAnnotation } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/tauri";

describe("annotationModel", () => {
  it("maps stored color names to CSS colors with a yellow fallback", () => {
    expect(highlightCssColor("green")).toBe("#4ade80");
    expect(highlightCssColor("magenta")).toBe("#facc15");
    expect(highlightCssColor(null)).toBe("#facc15");
  });

  it("filters annotations by kind and bookmark locators", () => {
    const bookmarkCfi = makeAnnotation({ kind: "bookmark", cfi: "epubcfi(/6/2)" });
    const bookmarkPage = makeAnnotation({ kind: "bookmark", pageNumber: 3, cfi: null });
    const highlight = makeAnnotation({ kind: "highlight" });
    const all = [bookmarkCfi, bookmarkPage, highlight];

    expect(byKind(all, "bookmark")).toEqual([bookmarkCfi, bookmarkPage]);
    expect(byKind(all, "highlight")).toEqual([highlight]);
    expect(isBookmarkAtCfi(bookmarkCfi, "epubcfi(/6/2)")).toBe(true);
    expect(isBookmarkAtCfi(bookmarkPage, "epubcfi(/6/2)")).toBe(false);
    expect(isBookmarkAtPage(bookmarkPage, 3)).toBe(true);
    expect(isBookmarkAtPage(bookmarkPage, 4)).toBe(false);
    expect(annotationRects(highlight)).toEqual(highlight.rects);
    expect(annotationRects(makeAnnotation({ rects: null }))).toEqual([]);
  });

  it("normalizes viewport rects into clamped page space", () => {
    const normalized = normalizeRect(new DOMRect(110, 210, 200, 20), 100, 200, 400, 600);
    expect(normalized.x).toBeCloseTo(0.025);
    expect(normalized.y).toBeCloseTo(10 / 600);
    expect(normalized.width).toBeCloseTo(0.5);
    expect(normalized.height).toBeCloseTo(20 / 600);
    // Selection rectangles can bleed past the page edges; both coordinates
    // and extents must stay inside 0..1.
    const bleeding = normalizeRect(new DOMRect(90, 190, 800, 700), 100, 200, 400, 600);
    expect(bleeding).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("useAnnotations", () => {
  it("loads the book's annotations and keeps the list per book", async () => {
    const stored = [makeAnnotation({ id: 3 })];
    mockInvoke({ list_annotations: stored });
    const { result, rerender } = renderHook(({ bookId }) => useAnnotations(bookId), {
      initialProps: { bookId: 1 },
    });

    await waitFor(() => expect(result.current.annotations).toEqual(stored));
    expect(invokeMock).toHaveBeenCalledWith("list_annotations", { bookId: 1 });

    // While another book loads, the visible list is empty, never stale.
    mockInvoke({ list_annotations: [makeAnnotation({ id: 8, bookId: 2 })] });
    rerender({ bookId: 2 });
    expect(result.current.annotations).toEqual([]);
    await waitFor(() => expect(result.current.annotations).toHaveLength(1));
  });

  it("creates, updates, and removes annotations through the backend", async () => {
    const stored = makeAnnotation({ id: 4, color: "green" });
    mockInvoke({
      list_annotations: [],
      create_annotation: stored,
      update_annotation: makeAnnotation({ id: 4, color: "green", note: "see chapter 2" }),
      delete_annotation: true,
    });
    const { result } = renderHook(() => useAnnotations(1));
    await waitFor(() => expect(result.current.annotations).toEqual([]));

    await act(() => result.current.create({ kind: "highlight", pageNumber: 2, color: "green" }));
    expect(invokeMock).toHaveBeenCalledWith("create_annotation", {
      bookId: 1,
      annotation: { kind: "highlight", pageNumber: 2, color: "green" },
    });
    expect(result.current.annotations).toEqual([stored]);

    await act(() => result.current.update(4, { note: "see chapter 2" }));
    expect(invokeMock).toHaveBeenCalledWith("update_annotation", {
      id: 4,
      patch: { note: "see chapter 2" },
    });
    expect(result.current.annotations[0]?.note).toBe("see chapter 2");

    await act(() => result.current.remove(4));
    expect(invokeMock).toHaveBeenCalledWith("delete_annotation", { id: 4 });
    expect(result.current.annotations).toEqual([]);
  });

  it("survives backend failures without losing the current list", async () => {
    mockInvoke({
      list_annotations: [makeAnnotation({ id: 2 })],
      delete_annotation: new Error("disk on fire"),
    });
    const { result } = renderHook(() => useAnnotations(1));
    await waitFor(() => expect(result.current.annotations).toHaveLength(1));

    await act(() => result.current.remove(2));
    expect(result.current.annotations).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("delete_annotation", { id: 2 });
  });
});
