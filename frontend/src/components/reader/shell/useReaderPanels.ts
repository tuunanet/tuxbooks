import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useShortcut } from "@/lib/shortcuts";
import { READER_PANEL_SHORTCUTS } from "@/lib/readerShortcuts";
import type { ReaderNavTab } from "../ReaderNavigation";

interface NavState {
  open: boolean;
  tab: ReaderNavTab;
}

/** Navigation drawer, PDF thumbnails, appearance popover, and their hosts. */
export function useReaderPanels() {
  const [nav, setNav] = useState<NavState>({ open: false, tab: "contents" });
  const [pdfSidebarOpen, setPdfSidebarOpen] = useState(false);
  const [pdfSidebarHost, setPdfSidebarHost] = useState<HTMLElement | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [pdfControlsHost, setPdfControlsHost] = useState<HTMLElement | null>(null);

  const openNav = (tab: ReaderNavTab) => setNav({ open: true, tab });
  // Drawer shortcut behavior: any drawer key closes the drawer whatever tab
  // is showing and never switches tabs while it is open; otherwise it opens
  // straight onto the requested tab.
  const toggleNav = (tab: ReaderNavTab) =>
    setNav((prev) => (prev.open ? { ...prev, open: false } : { open: true, tab }));
  const setNavOpen = (open: boolean) => setNav((prev) => ({ ...prev, open }));
  const selectNavTab = (tab: ReaderNavTab) => setNav((prev) => ({ ...prev, tab }));

  return {
    nav,
    openNav,
    toggleNav,
    setNavOpen,
    selectNavTab,
    pdfSidebarOpen,
    setPdfSidebarOpen,
    pdfSidebarHost,
    setPdfSidebarHost,
    appearanceOpen,
    setAppearanceOpen,
    pdfControlsHost,
    setPdfControlsHost,
  };
}

interface UseReaderPanelShortcutsInput {
  isEpub: boolean | undefined;
  appearanceOpen: boolean;
  contentRef: RefObject<HTMLElement | null>;
  toggleNav: (tab: ReaderNavTab) => void;
  setPdfSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setAppearanceOpen: Dispatch<SetStateAction<boolean>>;
}

/**
 * Panel shortcuts: thumbnails is a PDF affordance (the same `isEpub ? null`
 * gate as the page-turn combos), while the appearance popover and the
 * navigation drawer exist in both formats. The drawer keys toggle; a second
 * press closes the drawer instead of switching its tab.
 */
export function useReaderPanelShortcuts({
  isEpub,
  appearanceOpen,
  contentRef,
  toggleNav,
  setPdfSidebarOpen,
  setAppearanceOpen,
}: UseReaderPanelShortcutsInput) {
  const focusReadingSurface = useCallback(() => {
    // Only claim focus when nothing owns it. A shortcut fired from the EPUB
    // content frame (activeElement is the iframe) or a toolbar button must
    // keep that focus; focus left on body, by contrast, lets the drawer's
    // modal focus guard grab it when async contents land.
    if (document.activeElement === document.body) {
      contentRef.current?.focus({ preventScroll: true });
    }
  }, [contentRef]);

  useShortcut(isEpub ? null : READER_PANEL_SHORTCUTS.thumbnails, () =>
    setPdfSidebarOpen((open) => !open),
  );
  useShortcut(READER_PANEL_SHORTCUTS.appearance, () => setAppearanceOpen((open) => !open));
  // The EPUB navigator's capture-phase host listener intercepts Escape while
  // the reading frame owns focus, so Radix's popover never sees the key.
  // Close the controlled appearance popover through the same registry that
  // receives the forwarded key.
  useShortcut(appearanceOpen ? "escape" : null, () => setAppearanceOpen(() => false));
  useShortcut(READER_PANEL_SHORTCUTS.contents, () => {
    focusReadingSurface();
    toggleNav(isEpub ? "contents" : "outline");
  });
  useShortcut(READER_PANEL_SHORTCUTS.bookmarks, () => {
    focusReadingSurface();
    toggleNav("bookmarks");
  });
  useShortcut(READER_PANEL_SHORTCUTS.highlights, () => {
    focusReadingSurface();
    toggleNav("highlights");
  });
}
