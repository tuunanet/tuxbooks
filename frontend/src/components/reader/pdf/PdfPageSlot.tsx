import type { ReactNode } from "react";
import { PAGE_GAP_PX, type LayoutSlot } from "./pdfLayout";

/**
 * A page slot's rendering lifecycle (§ page lifecycle). Slots keep their
 * geometry in every state so evicted canvases never collapse the layout.
 */
export type PdfPageLifecycle =
  "unloaded" | "queued" | "loading" | "rendering" | "rendered" | "error";

interface PdfPageSlotProps {
  slot: LayoutSlot;
  /** True for every slot except the first (the gap sits above it). */
  gapAbove: boolean;
  state: PdfPageLifecycle;
  /** Slot content: the page canvas when active, nothing while unloaded. */
  children?: ReactNode;
  /** Registers the slot element for scroll targeting (callback ref). */
  registerRef?: (element: HTMLDivElement | null) => void;
}

/**
 * Layout-only reservation for one page. The slot owns geometry and
 * visibility; whatever renders inside it is decoupled, so pages can
 * disappear from memory without collapsing the document. `scroll-mt` keeps
 * scroll targets clear of the sticky toolbar.
 */
export function PdfPageSlot({ slot, gapAbove, state, children, registerRef }: PdfPageSlotProps) {
  return (
    <div
      ref={registerRef}
      data-pdf-slot={slot.pageNumber}
      data-render-state={state}
      style={{
        width: `${slot.width}px`,
        height: `${slot.height}px`,
        marginTop: gapAbove ? PAGE_GAP_PX : 0,
      }}
      className="shrink-0 scroll-mt-12"
    >
      {children}
    </div>
  );
}
