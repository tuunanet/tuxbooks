import { BookOpen, Presentation, Search, TableOfContents } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  formatShortcutAria,
  formatShortcutDisplay,
  READER_BOOK_MODE_SHORTCUT,
  READER_PANEL_SHORTCUTS,
  READER_SEARCH_SHORTCUTS,
} from "@/lib/readerShortcuts";
import { ArrowLeft } from "lucide-react";
import type { ReaderTheme } from "@/state/readerState";
import type { Annotation, Book } from "@/types/domain";
import { ReaderAppearance } from "../ReaderAppearance";
import { PdfHeaderControls } from "./PdfHeaderControls";
import { ReaderBookmarkControl } from "./ReaderBookmarkControl";

interface ReaderHeaderProps {
  book: Book;
  isPdf: boolean;
  isEpub: boolean;
  theme: ReaderTheme;
  bookMode: boolean;
  presentation: boolean;
  pdfSidebarOpen: boolean;
  onTogglePdfSidebar: () => void;
  onPdfControlsHost: (el: HTMLElement | null) => void;
  onOpenNav: () => void;
  onOpenSearch: () => void;
  onToggleBookMode: () => void;
  onTogglePresentation: () => void;
  appearanceOpen: boolean;
  onAppearanceOpenChange: (open: boolean) => void;
  bookmarked: boolean;
  onToggleBookmark: () => void;
  labelTarget: { bookmark: Annotation; hint: string } | null;
  onCloseLabel: () => void;
  onCommitLabel: (bookmarkId: number, label: string) => void;
  onBack: () => void;
}

/** The reader toolbar. Hidden entirely while presenting. */
export function ReaderHeader({
  book,
  isPdf,
  isEpub,
  theme,
  bookMode,
  presentation,
  pdfSidebarOpen,
  onTogglePdfSidebar,
  onPdfControlsHost,
  onOpenNav,
  onOpenSearch,
  onToggleBookMode,
  onTogglePresentation,
  appearanceOpen,
  onAppearanceOpenChange,
  bookmarked,
  onToggleBookmark,
  labelTarget,
  onCloseLabel,
  onCommitLabel,
  onBack,
}: ReaderHeaderProps) {
  if (presentation) return null;
  return (
    <header className="relative flex shrink-0 items-center gap-1 border-b border-[var(--reader-chrome-border,var(--border))] px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="reader-back"
            aria-label="Back to Library"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Back to Library</TooltipContent>
      </Tooltip>

      {isPdf && (
        <PdfHeaderControls
          sidebarOpen={pdfSidebarOpen}
          onToggleSidebar={onTogglePdfSidebar}
          onHost={onPdfControlsHost}
        />
      )}

      {/* Spacer: keeps the trailing controls at the right edge. The title is
          centered on the header itself, not on the space between the unequal
          left and right groups, since the PDF zoom controls make the left
          group much wider. */}
      <div className="min-w-0 flex-1" />

      <p
        data-testid="reader-title"
        className="pointer-events-none absolute top-1/2 left-1/2 max-w-[45%] -translate-x-1/2 -translate-y-1/2 truncate text-center text-sm font-medium"
      >
        {book.title}
      </p>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="reader-nav-trigger"
            aria-label="Contents and bookmarks"
            aria-keyshortcuts={formatShortcutAria(READER_PANEL_SHORTCUTS.contents)}
            onClick={onOpenNav}
          >
            <TableOfContents />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Contents (Ctrl+Shift+C)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="reader-search"
            aria-label="Search in book"
            aria-keyshortcuts={formatShortcutAria(READER_SEARCH_SHORTCUTS.primary)}
            onClick={onOpenSearch}
          >
            <Search />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Search in book ({formatShortcutDisplay(READER_SEARCH_SHORTCUTS.primary)})
        </TooltipContent>
      </Tooltip>

      {/* Book mode (spec tuxbooks-9pr, stories 25/26): the header twin of the
          appearance popover's viewer/book segment group, same shared flag, so
          one control behaves identically in both readers. Its pressed state
          mirrors the popover segment: the icon fills while on. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="reader-book-mode"
            aria-label="Book mode"
            aria-keyshortcuts={formatShortcutAria(READER_BOOK_MODE_SHORTCUT)}
            aria-pressed={bookMode}
            onClick={onToggleBookMode}
          >
            <BookOpen className={bookMode ? "fill-current" : undefined} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Book mode ({formatShortcutDisplay(READER_BOOK_MODE_SHORTCUT)})
        </TooltipContent>
      </Tooltip>

      <ReaderAppearance
        format={book.format}
        open={appearanceOpen}
        onOpenChange={onAppearanceOpenChange}
      />

      {isEpub && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="epub-presentation-toggle"
              title="Presentation mode (Ctrl+L)"
              aria-label="Presentation mode (Ctrl+L)"
              aria-pressed={presentation}
              onClick={onTogglePresentation}
            >
              <Presentation />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Presentation mode (Ctrl+L)</TooltipContent>
        </Tooltip>
      )}

      <ReaderBookmarkControl
        bookmarked={bookmarked}
        onToggle={onToggleBookmark}
        labelTarget={labelTarget}
        onCloseLabel={onCloseLabel}
        onCommitLabel={onCommitLabel}
        theme={theme}
      />
    </header>
  );
}
