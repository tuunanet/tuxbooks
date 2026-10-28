import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatShortcutAria, READER_PANEL_SHORTCUTS } from "@/lib/readerShortcuts";

interface PdfHeaderControlsProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onHost: (el: HTMLElement | null) => void;
}

/**
 * The PDF-only left group: the portal slot the PDF reader docks its page and
 * zoom controls into, and the thumbnails toggle.
 */
export function PdfHeaderControls({
  sidebarOpen,
  onToggleSidebar,
  onHost,
}: PdfHeaderControlsProps) {
  return (
    <>
      <div ref={onHost} data-testid="pdf-header-controls" className="flex shrink-0 items-center" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="reader-sidebar-toggle"
            aria-label="Toggle page thumbnails"
            aria-keyshortcuts={formatShortcutAria(READER_PANEL_SHORTCUTS.thumbnails)}
            aria-pressed={sidebarOpen}
            onClick={onToggleSidebar}
          >
            <PanelLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Page thumbnails (Ctrl+Shift+T)</TooltipContent>
      </Tooltip>
    </>
  );
}
