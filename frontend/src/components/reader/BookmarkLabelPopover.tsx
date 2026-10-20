import { useState } from "react";

import { Input } from "@/components/ui/input";
import { PopoverContent } from "@/components/ui/popover";
import { clampBookmarkLabel } from "@/lib/annotationLocation";
import { epubSurfaceTheme, readerPopoverVariables, type ReaderTheme } from "@/lib/epub/appearance";

/**
 * The label editor that drops out of the toolbar's bookmark button right
 * after a bookmark is created (issue: naming a bookmark at toggle time).
 *
 * Anchored to the button by the caller's `PopoverAnchor`; every dismissal
 * path — Enter, Escape, outside click — commits the trimmed draft, and the
 * component only mounts while a bookmark is being labeled, so each opening
 * starts from an empty draft. An empty draft leaves the label untouched;
 * the reader drawer and the details tab remain the editors for existing
 * bookmarks.
 */
export interface BookmarkLabelPopoverProps {
  /** The just-created bookmark being labeled. */
  bookmarkId: number;
  /** Muted hint: location, in-chapter progress, and the saved time. */
  hint: string;
  /** The reader's active theme, so the card follows it (UAT). */
  theme: ReaderTheme;
  /** Persists the label; `label` is trimmed and non-empty. */
  onCommit: (bookmarkId: number, label: string) => void;
  /** Closes the popover (the caller clears its open state). */
  onClose: () => void;
}

export function BookmarkLabelPopover({
  bookmarkId,
  hint,
  theme,
  onCommit,
  onClose,
}: BookmarkLabelPopoverProps) {
  const [draft, setDraft] = useState("");

  const commitAndClose = () => {
    const label = draft.trim();
    if (label !== "") onCommit(bookmarkId, label);
    setDraft("");
    onClose();
  };

  return (
    <PopoverContent
      data-testid="bookmark-label-popover"
      align="end"
      sideOffset={8}
      collisionPadding={8}
      // Portaled outside the reader root: redefine the app tokens in this
      // scope so the card follows the reader theme instead of the global
      // light/dark mode (same treatment as the appearance popover and the
      // nav drawer).
      style={readerPopoverVariables(epubSurfaceTheme(theme))}
      // Focus belongs in the input, not on the card.
      onOpenAutoFocus={(event) => event.preventDefault()}
      // Escape and outside clicks both mean "done": commit, then let the
      // popover close through its root.
      onEscapeKeyDown={commitAndClose}
      onPointerDownOutside={commitAndClose}
    >
      <Input
        data-testid="bookmark-label-input"
        autoFocus
        placeholder="Label this bookmark"
        aria-label="Bookmark label"
        value={draft}
        onChange={(event) => setDraft(clampBookmarkLabel(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitAndClose();
          }
        }}
      />
      <p data-testid="bookmark-label-hint" className="px-1 text-xs text-muted-foreground">
        {hint}
      </p>
    </PopoverContent>
  );
}
