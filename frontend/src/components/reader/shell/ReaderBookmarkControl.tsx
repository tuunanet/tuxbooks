import { Bookmark, BookmarkCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReaderTheme } from "@/state/readerState";
import type { Annotation } from "@/types/domain";
import { BookmarkLabelPopover } from "../BookmarkLabelPopover";

interface ReaderBookmarkControlProps {
  bookmarked: boolean;
  onToggle: () => void;
  labelTarget: { bookmark: Annotation; hint: string } | null;
  onCloseLabel: () => void;
  onCommitLabel: (bookmarkId: number, label: string) => void;
  theme: ReaderTheme;
}

/**
 * Bookmark toggle with its label popover. The popover sits over the same
 * corner, so the tooltip is suppressed while it is open.
 */
export function ReaderBookmarkControl({
  bookmarked,
  onToggle,
  labelTarget,
  onCloseLabel,
  onCommitLabel,
  theme,
}: ReaderBookmarkControlProps) {
  return (
    <Popover
      open={labelTarget !== null}
      onOpenChange={(open) => {
        if (!open) onCloseLabel();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverAnchor asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="reader-bookmark"
              aria-label={bookmarked ? "Remove bookmark" : "Add bookmark"}
              aria-pressed={bookmarked}
              onClick={onToggle}
            >
              {bookmarked ? <BookmarkCheck className="fill-current" /> : <Bookmark />}
            </Button>
          </PopoverAnchor>
        </TooltipTrigger>
        {labelTarget === null && <TooltipContent>Bookmark (Ctrl+B)</TooltipContent>}
      </Tooltip>
      {labelTarget !== null && (
        // Keyed by id: a rebind (Ctrl+B at a new position while the popover
        // is up) discards the previous draft and starts blank.
        <BookmarkLabelPopover
          key={labelTarget.bookmark.id}
          bookmarkId={labelTarget.bookmark.id}
          hint={labelTarget.hint}
          theme={theme}
          onCommit={onCommitLabel}
          onClose={onCloseLabel}
        />
      )}
    </Popover>
  );
}
