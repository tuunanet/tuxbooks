import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import type { ReactVirtualizer } from "@tanstack/react-virtual";
import type { Book } from "@/types/domain";
import { LibraryRow, VirtualRow } from "./LibraryRow";

interface LibraryScrollAreaProps {
  visible: Book[];
  isGrid: boolean;
  columnCount: number;
  fallbackRowCount: number;
  unvirtualized: boolean;
  virtualizer: ReactVirtualizer<HTMLDivElement, Element>;
  attachScroller: (el: HTMLDivElement | null) => void;
  onScroll: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onFocusCapture: (event: ReactFocusEvent<HTMLElement>) => void;
  renderCard: (book: Book, index: number) => ReactNode;
}

/**
 * The scrollport around the rows. The selection and focus rings paint
 * outside the card (ring-2 and ring-3 box-shadows) and this box is their clip,
 * so it needs room around the grid. The padding keeps the rings inside it on
 * every edge; the matching negative margins keep the cards aligned with the
 * header and leave the content box, and with it the column count, exactly
 * where it was.
 *
 * `overflow-anchor` is off, mirroring ReaderShell: Chromium's scroll
 * anchoring adjusts scrollTop when virtualizer height corrections land above
 * the viewport (upward scrolls), double-compensating against the
 * deferred-measurement flush (tuxbooks-y9s).
 */
export function LibraryScrollArea({
  visible,
  isGrid,
  columnCount,
  fallbackRowCount,
  unvirtualized,
  virtualizer,
  attachScroller,
  onScroll,
  onKeyDown,
  onFocusCapture,
  renderCard,
}: LibraryScrollAreaProps) {
  return (
    <div
      ref={attachScroller}
      data-testid={isGrid ? "book-grid" : "book-list"}
      onKeyDown={onKeyDown}
      onFocusCapture={onFocusCapture}
      onScroll={onScroll}
      className="-m-1.5 min-h-0 flex-1 overflow-y-auto p-1.5 [overflow-anchor:none] [scrollbar-gutter:stable]"
    >
      {unvirtualized ? (
        <div>
          {Array.from({ length: fallbackRowCount }, (_, rowIndex) => (
            <LibraryRow
              key={rowIndex}
              books={visible}
              rowIndex={rowIndex}
              columnCount={columnCount}
              isGrid={isGrid}
              renderCard={renderCard}
            />
          ))}
        </div>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => (
            <VirtualRow
              key={virtualRow.key}
              index={virtualRow.index}
              start={virtualRow.start}
              measure={virtualizer.measureElement}
            >
              <LibraryRow
                books={visible}
                rowIndex={virtualRow.index}
                columnCount={columnCount}
                isGrid={isGrid}
                renderCard={renderCard}
              />
            </VirtualRow>
          ))}
        </div>
      )}
    </div>
  );
}
