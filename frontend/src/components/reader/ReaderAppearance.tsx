import type { CSSProperties } from "react";
import {
  ALargeSmall,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  BookOpen,
  CaseSensitive,
  Columns2,
  Columns3,
  Columns4,
  Contrast,
  Droplets,
  FileText,
  FlipVertical2,
  Frame,
  LayoutTemplate,
  Leaf,
  Moon,
  MoveVertical,
  Palette,
  Pilcrow,
  RectangleVertical,
  RotateCcw,
  ScrollText,
  Sun,
  SunMoon,
  SwatchBook,
  TextAlignStart,
  TextCursorInput,
  Type,
  WrapText,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  clampEpubColumnCount,
  EPUB_COLUMN_COUNTS,
  EPUB_DEFAULT_FONT_SIZE_PERCENT,
  EPUB_DEFAULT_LINE_HEIGHT,
  EPUB_DEFAULT_PAGE_GUTTER_PX,
  EPUB_FONT_FAMILIES,
  EPUB_FONT_SIZE_SCALE_PERCENT,
  EPUB_FOREGROUND_AA_RATIO,
  EPUB_FOREGROUND_SWATCHES,
  EPUB_LETTER_SPACING_SCALE,
  EPUB_LINE_HEIGHT_SCALE,
  EPUB_PAGE_GUTTER_SCALE_PX,
  EPUB_PARAGRAPH_SPACING_SCALE,
  EPUB_TEXT_ALIGNMENTS,
  EPUB_THEME_LABELS,
  EPUB_THEME_NAMES,
  EPUB_WORD_SPACING_SCALE,
  epubContrastRatio,
  epubForegroundReferenceBackground,
  epubSurfaceTheme,
  epubThemeColors,
  isEpubHexColor,
  nearestEpubFontSize,
  nearestEpubLetterSpacing,
  nearestEpubLineHeight,
  nearestEpubPageGutter,
  nearestEpubParagraphSpacing,
  nearestEpubWordSpacing,
  type EpubFontFamily,
  type EpubTextAlignment,
} from "@/lib/epub/appearance";
import { PDF_THEME_MENU_OPTIONS } from "@/lib/pdf/theme";
import { formatShortcutAria, READER_PANEL_SHORTCUTS } from "@/lib/readerShortcuts";
import { readerThemeStyle } from "@/lib/themeScope";
import { cn } from "@/lib/utils";
import { ForegroundPicker } from "./ForegroundPicker";
import {
  useReader,
  type ReaderLayout,
  type ReaderPreferences,
  type ReaderTheme,
} from "@/state/readerState";

const THEME_OPTIONS: { value: ReaderTheme; label: string }[] = EPUB_THEME_NAMES.map((value) => ({
  value,
  label: EPUB_THEME_LABELS[value],
}));

/** Symbols are the visual key; the swatch underneath shows the palette. */
const THEME_ICONS: Record<ReaderTheme, LucideIcon> = {
  default: SunMoon,
  light: Sun,
  paper: FileText,
  dark: Moon,
  contrast: Contrast,
  invert: FlipVertical2,
  "blue-contrast": Droplets,
  "mint-contrast": Leaf,
};

const LAYOUT_OPTIONS: { value: ReaderLayout; label: string; icon: LucideIcon }[] = [
  { value: "paginated", label: "Paginated", icon: BookOpen },
  { value: "scrolling", label: "Scrolling", icon: ScrollText },
];

const FONT_FAMILY_PREVIEW: Record<EpubFontFamily, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "var(--RS__sansTf, system-ui, sans-serif)",
  humanist: "var(--RS__humanistTf, Optima, Candara, sans-serif)",
  "old-style": "var(--RS__oldStyleTf, Palatino, 'Palatino Linotype', serif)",
  modern: "var(--RS__modernTf, Didot, 'Bodoni MT', serif)",
  duospace: "'IA Writer Duospace', 'SF Mono', Consolas, monospace",
  readable: "'AccessibleDfA', Verdana, Tahoma, 'Comic Sans MS', sans-serif",
};

const TEXT_ALIGN_ICONS: Record<EpubTextAlignment, LucideIcon> = {
  auto: TextCursorInput,
  left: AlignLeft,
  justify: AlignJustify,
  right: AlignRight,
  start: TextAlignStart,
};

const COLUMN_COUNT_ICONS: Record<(typeof EPUB_COLUMN_COUNTS)[number], LucideIcon> = {
  1: RectangleVertical,
  2: Columns2,
  3: Columns3,
  4: Columns4,
};

function columnCountLabel(count: number): string {
  return count === 1 ? "One column" : `${count} columns`;
}

const FONT_FAMILY_OPTIONS: { value: EpubFontFamily; label: string }[] = [
  { value: "serif", label: "Serif" },
  { value: "sans", label: "Sans" },
  { value: "humanist", label: "Humanist" },
  { value: "old-style", label: "Old Style" },
  { value: "modern", label: "Modern" },
  { value: "duospace", label: "Duospace" },
  { value: "readable", label: "Readable" },
];

const TEXT_ALIGN_LABELS: Record<EpubTextAlignment, string> = {
  auto: "Auto",
  left: "Left",
  justify: "Justify",
  right: "Right",
  start: "Start",
};

function ControlLabel({ icon: Icon, children }: { icon: LucideIcon; children: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      {children}
    </span>
  );
}

function SectionLabel({ icon: Icon, children }: { icon: LucideIcon; children: string }) {
  return (
    <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      {children}
    </p>
  );
}

/**
 * A discrete reading-system scale slider (issue #43/#45): 0 is always the
 * publication-default sentinel ("Default" label + reset, no CSS override).
 */
function ScaleSliderRow(props: {
  label: string;
  icon: LucideIcon;
  sliderTestId: string;
  scale: readonly number[];
  value: number;
  onStep: (step: number) => void;
  /** What the reset button restores; 0 (publication default) unless overridden. */
  defaultValue?: number;
}) {
  const defaultValue = props.defaultValue ?? 0;
  const atDefault = props.value === defaultValue;
  const index = props.scale.indexOf(props.value);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <ControlLabel icon={props.icon}>{props.label}</ControlLabel>
        <span className="flex items-center gap-1">
          <span className="tabular-nums text-muted-foreground">
            {atDefault ? "Default" : props.value}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            data-testid={`pref-${props.sliderTestId}-reset`}
            aria-label={`Reset ${props.label.toLowerCase()}`}
            disabled={atDefault}
            onClick={() => props.onStep(defaultValue)}
          >
            <RotateCcw />
          </Button>
        </span>
      </div>
      <Slider
        data-testid={`pref-${props.sliderTestId}`}
        aria-label={props.label}
        min={0}
        max={props.scale.length - 1}
        step={1}
        value={[index]}
        onValueChange={(values) => {
          const next = values[0];
          const step = next !== undefined ? props.scale[next] : undefined;
          if (step !== undefined) {
            props.onStep(step);
          }
        }}
      />
    </div>
  );
}

/**
 * Reading appearance controls, shared by the reader popover and the Settings
 * default editor. For EPUB: font size, line spacing, font family, alignment,
 * theme, layout, paginated column count and page margins — the reflow
 * controls only exist for reflowable content. For PDF (fixed layout) the
 * reflow sections would do nothing, so only the theme is offered, applied as
 * a filter over the rendered pages (lib/pdf/theme.ts, the Foliate approach;
 * mainstream readers ship no PDF theming at all). The host owns the state:
 * the reader passes its context preferences, Settings passes the persisted
 * defaults.
 */
export function ReaderAppearanceControls({
  preferences,
  surfaceTheme = preferences.theme,
  setPreferences,
  format,
}: {
  preferences: ReaderPreferences;
  /** Applied theme when Default resolves to a concrete preset. */
  surfaceTheme?: ReaderTheme;
  setPreferences: (patch: Partial<ReaderPreferences>) => void;
  format?: string;
}) {
  const isPdf = format === "pdf";

  // The sliders walk the supported Readium scales by index; the state holds
  // the scale values themselves, snapped so an off-scale value (e.g. a
  // future stored preference) can never wedge a slider.
  const fontSize = nearestEpubFontSize(preferences.epubFontSize);
  const fontSizeIndex = EPUB_FONT_SIZE_SCALE_PERCENT.indexOf(fontSize);
  const atDefaultFontSize = fontSize === EPUB_DEFAULT_FONT_SIZE_PERCENT;

  const lineHeight = nearestEpubLineHeight(preferences.lineHeight);
  const lineHeightIndex = EPUB_LINE_HEIGHT_SCALE.indexOf(lineHeight);
  const atDefaultLineHeight = lineHeight === EPUB_DEFAULT_LINE_HEIGHT;

  // Explicit 1–4 target (issue #44); only offered for paginated reflow, and
  // the stored value survives switching to scrolling untouched.
  const columnCount = clampEpubColumnCount(preferences.columnCount);

  // Foreground override (issue #55): null = the active theme's (or
  // publisher's) text color. The readout judges the effective color — the
  // override, or the theme's own — against the surface actually applied
  // (Default in a dark app resolves to the dark preset). The palette lookup
  // uses the EPUB-facing theme: a PDF-only Invert pick maps onto the dark
  // preset's colors.
  const themePalette = epubThemeColors(epubSurfaceTheme(surfaceTheme));
  const referenceBackground = epubForegroundReferenceBackground(epubSurfaceTheme(surfaceTheme));
  const effectiveForeground = preferences.foreground ?? themePalette?.text ?? null;
  const foregroundRatio =
    effectiveForeground !== null && isEpubHexColor(effectiveForeground)
      ? epubContrastRatio(effectiveForeground, referenceBackground)
      : null;
  const belowAA = foregroundRatio !== null && foregroundRatio < EPUB_FOREGROUND_AA_RATIO;

  // PDFs expose theme choices with a faithful treatment (issue #67: Smart
  // dark recolors in the worker, Invert is the explicit negative) — a
  // superset of the EPUB-faithful filter list.
  const themeOptions = isPdf ? PDF_THEME_MENU_OPTIONS : THEME_OPTIONS;
  const themeSwatchStyle = (value: ReaderTheme): CSSProperties | undefined => {
    const colors = epubThemeColors(epubSurfaceTheme(value));
    return colors ? { backgroundColor: colors.background, color: colors.text } : undefined;
  };

  const themeSection = (
    <div>
      <SectionLabel icon={Palette}>Theme</SectionLabel>
      <ToggleGroup
        data-testid="pref-theme"
        type="single"
        size="sm"
        variant="outline"
        spacing={2}
        className="flex-wrap gap-1.5"
        value={preferences.theme}
        onValueChange={(value) => value && setPreferences({ theme: value as ReaderTheme })}
        aria-label="Theme"
      >
        {themeOptions.map((option) => {
          const Icon = THEME_ICONS[option.value];
          return (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              aria-label={option.label}
              title={option.label}
              className="h-8 gap-1 rounded-md px-1.5 text-xs data-[state=on]:ring-2 data-[state=on]:ring-ring data-[state=on]:ring-offset-2 data-[state=on]:ring-offset-background"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-[3px] border border-border/60",
                  option.value === "default" && "border-border bg-muted text-foreground",
                )}
                style={themeSwatchStyle(option.value)}
              >
                <Icon className="size-3" />
              </span>
              {option.label}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </div>
  );

  return (
    <>
      {/* PDFs expose only the theme; EPUB gets the full reflow set.
          Two balanced columns keep the popover short enough to avoid
          scrollbars on normal windows; the max-height is only a fallback
          for very short ones. Sliders live on the left, choice groups on
          the right. */}
      {isPdf ? (
        themeSection
      ) : (
        <div className="grid grid-cols-2 gap-x-5">
          <div className="flex flex-col gap-3">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <ControlLabel icon={ALargeSmall}>Font size</ControlLabel>
                <span className="flex items-center gap-1">
                  <span className="tabular-nums text-muted-foreground">{fontSize}%</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    data-testid="pref-font-size-reset"
                    aria-label="Reset font size"
                    disabled={atDefaultFontSize}
                    onClick={() => setPreferences({ epubFontSize: EPUB_DEFAULT_FONT_SIZE_PERCENT })}
                  >
                    <RotateCcw />
                  </Button>
                </span>
              </div>
              <Slider
                data-testid="pref-font-size"
                aria-label="Font size"
                min={0}
                max={EPUB_FONT_SIZE_SCALE_PERCENT.length - 1}
                step={1}
                value={[fontSizeIndex]}
                onValueChange={(values) => {
                  const index = values[0];
                  if (index !== undefined) {
                    setPreferences({ epubFontSize: EPUB_FONT_SIZE_SCALE_PERCENT[index] });
                  }
                }}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <ControlLabel icon={MoveVertical}>Line spacing</ControlLabel>
                <span className="flex items-center gap-1">
                  <span className="tabular-nums text-muted-foreground">
                    {atDefaultLineHeight ? "Default" : lineHeight}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    data-testid="pref-line-height-reset"
                    aria-label="Reset line spacing"
                    disabled={atDefaultLineHeight}
                    onClick={() => setPreferences({ lineHeight: EPUB_DEFAULT_LINE_HEIGHT })}
                  >
                    <RotateCcw />
                  </Button>
                </span>
              </div>
              <Slider
                data-testid="pref-line-height"
                aria-label="Line spacing"
                min={0}
                max={EPUB_LINE_HEIGHT_SCALE.length - 1}
                step={1}
                value={[lineHeightIndex]}
                onValueChange={(values) => {
                  const index = values[0];
                  if (index !== undefined) {
                    setPreferences({ lineHeight: EPUB_LINE_HEIGHT_SCALE[index] });
                  }
                }}
              />
            </div>

            {/* Text-layout scales (issue #45): 0 = publication default, mapped
                to the toolkit's "no preference" at the seam. They apply in
                both paginated and scrolling flow. */}
            <ScaleSliderRow
              label="Word spacing"
              icon={WrapText}
              sliderTestId="word-spacing"
              scale={EPUB_WORD_SPACING_SCALE}
              value={nearestEpubWordSpacing(preferences.wordSpacing)}
              onStep={(step) => setPreferences({ wordSpacing: step })}
            />
            <ScaleSliderRow
              label="Letter spacing"
              icon={CaseSensitive}
              sliderTestId="letter-spacing"
              scale={EPUB_LETTER_SPACING_SCALE}
              value={nearestEpubLetterSpacing(preferences.letterSpacing)}
              onStep={(step) => setPreferences({ letterSpacing: step })}
            />
            <ScaleSliderRow
              label="Paragraph spacing"
              icon={Pilcrow}
              sliderTestId="paragraph-spacing"
              scale={EPUB_PARAGRAPH_SPACING_SCALE}
              value={nearestEpubParagraphSpacing(preferences.paragraphSpacing)}
              onStep={(step) => setPreferences({ paragraphSpacing: step })}
            />
            {/* Page margins are pagination-scoped in the reading system (body
                padding applies only outside scroll flow). */}
            {preferences.layout === "paginated" && (
              <ScaleSliderRow
                label="Page margins"
                icon={Frame}
                sliderTestId="page-gutter"
                scale={EPUB_PAGE_GUTTER_SCALE_PX}
                value={nearestEpubPageGutter(preferences.pageGutter)}
                onStep={(step) => setPreferences({ pageGutter: step })}
                defaultValue={EPUB_DEFAULT_PAGE_GUTTER_PX}
              />
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div>
              <SectionLabel icon={Type}>Font</SectionLabel>
              <ToggleGroup
                data-testid="pref-font-family"
                type="single"
                size="sm"
                variant="outline"
                spacing={0}
                className="flex-wrap"
                value={preferences.fontFamily ?? "default"}
                onValueChange={(value) =>
                  setPreferences({
                    fontFamily:
                      value === "default"
                        ? null
                        : (value as EpubFontFamily) in EPUB_FONT_FAMILIES
                          ? (value as EpubFontFamily)
                          : null,
                  })
                }
                aria-label="Font family"
              >
                {FONT_FAMILY_OPTIONS.map((option) => (
                  <ToggleGroupItem
                    key={option.value}
                    value={option.value}
                    style={{ fontFamily: FONT_FAMILY_PREVIEW[option.value] }}
                  >
                    {option.label}
                  </ToggleGroupItem>
                ))}
                <ToggleGroupItem value="default">Default</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div>
              <SectionLabel icon={TextAlignStart}>Alignment</SectionLabel>
              <ToggleGroup
                data-testid="pref-text-align"
                type="single"
                size="sm"
                variant="outline"
                spacing={0}
                className="flex-wrap"
                value={preferences.textAlign}
                onValueChange={(value) =>
                  value && setPreferences({ textAlign: value as EpubTextAlignment })
                }
                aria-label="Text alignment"
              >
                {EPUB_TEXT_ALIGNMENTS.map((alignment) => {
                  const Icon = TEXT_ALIGN_ICONS[alignment];
                  return (
                    <ToggleGroupItem key={alignment} value={alignment} className="gap-1">
                      <Icon aria-hidden="true" className="size-3.5" />
                      {TEXT_ALIGN_LABELS[alignment]}
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>
            </div>

            {themeSection}

            {/* Foreground override (issue #55): composes on top of the
                  active theme; links/visited/selection keep their theme
                  colors (toolkit semantics). The readout never blocks a
                  choice — it only informs. */}
            <div>
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <ControlLabel icon={Baseline}>Foreground</ControlLabel>
                <span className="flex items-center gap-1">
                  <span
                    data-testid="foreground-contrast"
                    title="Contrast against the theme background (WCAG AA needs 4.5:1)"
                    className={cn(
                      "tabular-nums text-muted-foreground",
                      belowAA && "text-destructive",
                    )}
                  >
                    {foregroundRatio === null ? "—" : `${foregroundRatio.toFixed(1)}:1`}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    data-testid="pref-foreground-reset"
                    aria-label="Reset foreground color"
                    disabled={preferences.foreground === null}
                    onClick={() => setPreferences({ foreground: null })}
                  >
                    <RotateCcw />
                  </Button>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {EPUB_FOREGROUND_SWATCHES.map((swatch) => (
                  <button
                    key={swatch.color}
                    type="button"
                    data-testid={`pref-foreground-${swatch.label.toLowerCase()}`}
                    aria-label={`${swatch.label} (${swatch.color})`}
                    aria-pressed={preferences.foreground === swatch.color}
                    title={swatch.label}
                    className={cn(
                      "h-6 w-6 rounded-full border border-border",
                      preferences.foreground === swatch.color && "ring-2 ring-primary",
                    )}
                    style={{ backgroundColor: swatch.color }}
                    onClick={() => setPreferences({ foreground: swatch.color })}
                  />
                ))}
                <ForegroundPicker
                  value={
                    preferences.foreground && isEpubHexColor(preferences.foreground)
                      ? preferences.foreground
                      : "#1f2328"
                  }
                  onChange={(hex) => setPreferences({ foreground: hex })}
                />
              </div>
            </div>

            <div>
              <SectionLabel icon={LayoutTemplate}>Layout</SectionLabel>
              <ToggleGroup
                data-testid="pref-layout"
                type="single"
                size="sm"
                variant="outline"
                spacing={0}
                value={preferences.layout}
                onValueChange={(value) =>
                  value && setPreferences({ layout: value as ReaderLayout })
                }
                aria-label="Layout"
              >
                {LAYOUT_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  return (
                    <ToggleGroupItem key={option.value} value={option.value} className="gap-1">
                      <Icon aria-hidden="true" className="size-3.5" />
                      {option.label}
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>
              {preferences.layout === "paginated" && (
                <div className="mt-3">
                  <SectionLabel icon={Columns3}>Columns</SectionLabel>
                  <ToggleGroup
                    data-testid="pref-columns"
                    type="single"
                    size="sm"
                    variant="outline"
                    spacing={0}
                    value={String(columnCount)}
                    onValueChange={(value) =>
                      value && setPreferences({ columnCount: Number(value) })
                    }
                    aria-label="Column count"
                  >
                    {EPUB_COLUMN_COUNTS.map((count) => {
                      const Icon = COLUMN_COUNT_ICONS[count];
                      const label = columnCountLabel(count);
                      return (
                        <ToggleGroupItem
                          key={count}
                          value={String(count)}
                          aria-label={label}
                          title={label}
                          className="gap-1"
                        >
                          <Icon aria-hidden="true" className="size-3.5" />
                          {count}
                        </ToggleGroupItem>
                      );
                    })}
                  </ToggleGroup>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Reader toolbar control: the appearance popover wrapping the shared
 * controls. The reader shell may drive it from a shortcut by passing `open`
 * and `onOpenChange`; without them it stays uncontrolled, so Settings and
 * other callers keep working untouched.
 */
export function ReaderAppearance({
  format,
  open,
  onOpenChange,
}: {
  format?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { preferences, effectiveTheme, setPreferences } = useReader();
  const isPdf = format === "pdf";
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="appearance-trigger"
              aria-label="Reading appearance"
              aria-keyshortcuts={formatShortcutAria(READER_PANEL_SHORTCUTS.appearance)}
            >
              <Type />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Appearance (Ctrl+Shift+A)</TooltipContent>
      </Tooltip>
      <PopoverContent
        data-testid="appearance-content"
        align="end"
        className={cn(
          "max-h-[85vh] flex-col gap-0 overflow-hidden p-0",
          // PDFs expose only the theme — a narrow popover; the EPUB reflow
          // controls use the wider two-column shape that avoids scrollbars.
          isPdf ? "w-64" : "w-[min(32rem,calc(100vw-1rem))]",
        )}
        // The popover is portaled outside the reader root; carry the full
        // reader token set so it follows the book's theme instead of the
        // global light/dark mode.
        style={readerThemeStyle(effectiveTheme)}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3.5 py-2.5">
          <SwatchBook aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Appearance</span>
          <span className="ml-auto text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {isPdf ? "PDF" : "EPUB"}
          </span>
        </div>
        <div className="min-h-0 overflow-y-auto p-3">
          <ReaderAppearanceControls
            preferences={preferences}
            surfaceTheme={effectiveTheme}
            setPreferences={setPreferences}
            format={format}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
