import { ChevronDown, Minus, Plus, Presentation } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  formatZoomPercent,
  parseZoomPercent,
  ZOOM_PRESETS,
  type FitZoomMode,
  type ZoomMode,
} from "./pdfLayout";
import { PdfPageField } from "./PdfPageField";

interface PdfToolbarProps {
  pageNumber: number;
  pageCount: number;
  /** The active zoom mode (fit-* are dynamic; custom is a fixed scale). */
  zoomMode: ZoomMode;
  /** Effective zoom scale (1 = 100%), shown in the editable input. */
  zoomScale: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** Jumps to a typed page via the reader's `goToPage` path. */
  onSetPage: (page: number) => void;
  /** Disables the page field until the reader layout is ready. */
  pageEntryDisabled?: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Switches to a dynamic fit mode from the zoom dropdown. */
  onSelectFit: (mode: FitZoomMode) => void;
  /** Applies a typed or preset custom scale (1 = 100%). */
  onSetZoom: (scale: number) => void;
  /** Toggles presentation mode (Ctrl+L); omitted when unsupported. */
  onTogglePresentation?: () => void;
  presentationActive?: boolean;
}

/** The three fit modes offered at the top of the zoom dropdown, Okular-style. */
const FIT_MODES: ReadonlyArray<{
  mode: FitZoomMode;
  label: string;
  shortcut: string;
  testId: string;
}> = [
  { mode: "fit-width", label: "Fit Width", shortcut: "Ctrl+2", testId: "pdf-zoom-fit-width" },
  { mode: "fit-page", label: "Fit Page", shortcut: "Ctrl+1", testId: "pdf-zoom-fit-page" },
  { mode: "fit-auto", label: "Auto Fit", shortcut: "Ctrl+3", testId: "pdf-zoom-fit-auto" },
];

const ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none";

const SELECTED_ITEM_CLASS = " bg-accent font-medium text-accent-foreground";

/** Exact-enough scale comparison for the dropdown's selected state. */
function isSameScale(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

type PdfZoomControlProps = Pick<
  PdfToolbarProps,
  | "zoomMode"
  | "zoomScale"
  | "canZoomIn"
  | "canZoomOut"
  | "onZoomIn"
  | "onZoomOut"
  | "onSelectFit"
  | "onSetZoom"
>;

/**
 * The Okular-style zoom combo: an editable percentage input flanked by the
 * `−`/`+` steppers, with a dropdown of the three fit modes and the preset
 * percentages (`ZOOM_PRESETS`). Typing a percentage and pressing Enter (or
 * leaving the field) applies it; an unparseable value reverts. The input
 * reports the effective scale, so a dynamic fit mode keeps showing its real
 * percentage.
 */
function PdfZoomControl({
  zoomMode,
  zoomScale,
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
  onSelectFit,
  onSetZoom,
}: PdfZoomControlProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const display = draft ?? formatZoomPercent(zoomScale);

  const commit = () => {
    if (draft === null) return;
    const parsed = parseZoomPercent(draft);
    if (parsed !== null && !isSameScale(parsed, zoomScale)) onSetZoom(parsed);
    setDraft(null);
  };

  const chooseFit = (mode: FitZoomMode) => {
    if (zoomMode !== mode) onSelectFit(mode);
    setDraft(null);
    setOpen(false);
  };

  const choosePreset = (scale: number) => {
    if (zoomMode !== "custom" || !isSameScale(scale, zoomScale)) onSetZoom(scale);
    setDraft(null);
    setOpen(false);
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="pdf-zoom-out"
        aria-label="Zoom out (Ctrl+-)"
        disabled={!canZoomOut}
        onClick={onZoomOut}
      >
        <Minus />
      </Button>

      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          data-testid="pdf-zoom-input"
          aria-label="Zoom percentage"
          value={display}
          onFocus={(event) => {
            setDraft(display);
            event.currentTarget.select();
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
          className="h-7 w-16 rounded-md border border-[var(--reader-chrome-border,var(--border))] bg-transparent pr-5 pl-2 text-right text-xs tabular-nums text-[var(--reader-chrome-muted,var(--foreground))] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-[var(--reader-chrome-muted,var(--muted-foreground))]"
        >
          %
        </span>
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="pdf-zoom-menu"
            aria-label="Choose zoom level"
          >
            <ChevronDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="center" className="max-h-80 w-44 overflow-y-auto p-1">
          <div role="listbox" aria-label="Zoom levels" className="flex flex-col">
            {FIT_MODES.map((fit) => {
              const selected = zoomMode === fit.mode;
              return (
                <button
                  key={fit.mode}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid={fit.testId}
                  onClick={() => chooseFit(fit.mode)}
                  className={ITEM_CLASS + (selected ? SELECTED_ITEM_CLASS : "")}
                >
                  <span>{fit.label}</span>
                  <span className="ml-auto text-[10px] text-[var(--reader-chrome-muted,var(--muted-foreground))]">
                    {fit.shortcut}
                  </span>
                </button>
              );
            })}
            <Separator className="my-1" />
            {ZOOM_PRESETS.map((preset) => {
              const label = formatZoomPercent(preset);
              const selected = zoomMode === "custom" && isSameScale(preset, zoomScale);
              return (
                <button
                  key={label}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid={`pdf-zoom-preset-${label}`}
                  onClick={() => choosePreset(preset)}
                  className={ITEM_CLASS + (selected ? SELECTED_ITEM_CLASS : "")}
                >
                  {label}%
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="pdf-zoom-in"
        aria-label="Zoom in (Ctrl++)"
        disabled={!canZoomIn}
        onClick={onZoomIn}
      >
        <Plus />
      </Button>
    </div>
  );
}

/**
 * PDF document controls: page navigation (`‹ [1] of 991 ›`, an editable page
 * field), the Okular style zoom combo (`−`, an editable percent input with a presets dropdown
 * including fit modes, `+`), and the presentation-mode toggle — one compact
 * group docked into the shell's reader header via a portal (issue #68), so no
 * dedicated control row takes vertical space from the pages. The dropdown's
 * active item carries `aria-selected`. Native `title` tooltips instead of the
 * Radix Tooltip: the toolbar also renders standalone (inline fallback without
 * a shell host), where no TooltipProvider exists.
 */
export function PdfToolbar({
  pageNumber,
  pageCount,
  zoomMode,
  zoomScale,
  canZoomIn,
  canZoomOut,
  onPrev,
  onNext,
  onSetPage,
  pageEntryDisabled = false,
  onZoomIn,
  onZoomOut,
  onSelectFit,
  onSetZoom,
  onTogglePresentation,
  presentationActive = false,
}: PdfToolbarProps) {
  return (
    <div
      data-testid="pdf-toolbar"
      data-pdf-zoom-mode={zoomMode}
      role="group"
      aria-label="Page navigation and zoom"
      className="flex items-center gap-1"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="pdf-prev"
        aria-label="Previous page"
        disabled={pageNumber <= 1}
        onClick={onPrev}
      >
        <span aria-hidden="true">‹</span>
      </Button>
      <span data-testid="pdf-page-indicator" aria-live="polite" className="sr-only">
        Page {pageNumber} of {pageCount}
      </span>
      <PdfPageField
        pageNumber={pageNumber}
        pageCount={pageCount}
        disabled={pageEntryDisabled}
        onSetPage={onSetPage}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="pdf-next"
        aria-label="Next page"
        disabled={pageNumber >= pageCount}
        onClick={onNext}
      >
        <span aria-hidden="true">›</span>
      </Button>

      <span
        className="mx-2 h-4 w-px bg-[var(--reader-chrome-border,var(--border))]"
        aria-hidden="true"
      />

      <PdfZoomControl
        zoomMode={zoomMode}
        zoomScale={zoomScale}
        canZoomIn={canZoomIn}
        canZoomOut={canZoomOut}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onSelectFit={onSelectFit}
        onSetZoom={onSetZoom}
      />

      {onTogglePresentation && (
        <Button
          variant="ghost"
          size="icon-sm"
          title="Presentation mode (Ctrl+L)"
          data-testid="pdf-presentation-toggle"
          aria-label="Presentation mode (Ctrl+L)"
          aria-pressed={presentationActive}
          onClick={onTogglePresentation}
        >
          <Presentation />
        </Button>
      )}
    </div>
  );
}
