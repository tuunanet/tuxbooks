import { RotateCcw, Type } from "lucide-react";
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
  EPUB_FONT_FAMILIES,
  EPUB_FONT_SIZE_SCALE_PERCENT,
  EPUB_LETTER_SPACING_SCALE,
  EPUB_LINE_HEIGHT_SCALE,
  EPUB_PAGE_GUTTER_SCALE_PX,
  EPUB_PARAGRAPH_SPACING_SCALE,
  EPUB_TEXT_ALIGNMENTS,
  EPUB_WORD_SPACING_SCALE,
  nearestEpubFontSize,
  nearestEpubLetterSpacing,
  nearestEpubLineHeight,
  nearestEpubPageGutter,
  nearestEpubParagraphSpacing,
  nearestEpubWordSpacing,
  type EpubFontFamily,
  type EpubTextAlignment,
} from "@/lib/epub/appearance";
import { useReader, type ReaderLayout, type ReaderTheme } from "@/state/readerState";

const THEME_OPTIONS: { value: ReaderTheme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "paper", label: "Paper" },
  { value: "dark", label: "Dark" },
];

const LAYOUT_OPTIONS: { value: ReaderLayout; label: string }[] = [
  { value: "paginated", label: "Paginated" },
  { value: "scrolling", label: "Scrolling" },
];

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

/** Column counts are labeled with Roman numerals; the stored value stays numeric. */
const COLUMN_COUNT_LABELS: Record<number, string> = { 1: "I", 2: "II", 3: "III", 4: "IV" };

/**
 * A discrete reading-system scale slider (issue #43/#45): 0 is always the
 * publication-default sentinel ("Default" label + reset, no CSS override).
 */
function ScaleSliderRow(props: {
  label: string;
  sliderTestId: string;
  scale: readonly number[];
  value: number;
  onStep: (step: number) => void;
}) {
  const atDefault = props.value === 0;
  const index = props.scale.indexOf(props.value);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span>{props.label}</span>
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
            onClick={() => props.onStep(0)}
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
 * Reading appearance: font size, line spacing, font family, theme, layout,
 * paginated column count. State lives in the reader context so the whole
 * reading surface responds; persistence is a future backend concern and is
 * not faked here.
 */
export function ReaderAppearance() {
  const { preferences, setPreferences } = useReader();

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

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="appearance-trigger"
              aria-label="Reading appearance"
            >
              <Type />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Appearance (Aa)</TooltipContent>
      </Tooltip>
      <PopoverContent
        data-testid="appearance-content"
        align="end"
        className="max-h-[85vh] w-64 gap-4 overflow-y-auto"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>Font size</span>
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
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>Line spacing</span>
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

        {/* Text-layout scales (issue #45): 0 = publication default, mapped to
            the toolkit's "no preference" at the seam. They apply in both
            paginated and scrolling flow. */}
        <ScaleSliderRow
          label="Word spacing"
          sliderTestId="word-spacing"
          scale={EPUB_WORD_SPACING_SCALE}
          value={nearestEpubWordSpacing(preferences.wordSpacing)}
          onStep={(step) => setPreferences({ wordSpacing: step })}
        />
        <ScaleSliderRow
          label="Letter spacing"
          sliderTestId="letter-spacing"
          scale={EPUB_LETTER_SPACING_SCALE}
          value={nearestEpubLetterSpacing(preferences.letterSpacing)}
          onStep={(step) => setPreferences({ letterSpacing: step })}
        />
        <ScaleSliderRow
          label="Paragraph spacing"
          sliderTestId="paragraph-spacing"
          scale={EPUB_PARAGRAPH_SPACING_SCALE}
          value={nearestEpubParagraphSpacing(preferences.paragraphSpacing)}
          onStep={(step) => setPreferences({ paragraphSpacing: step })}
        />

        <div>
          <p className="mb-2 text-sm">Font</p>
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
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="default">Default</ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div>
          <p className="mb-2 text-sm">Alignment</p>
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
            {EPUB_TEXT_ALIGNMENTS.map((alignment) => (
              <ToggleGroupItem key={alignment} value={alignment}>
                {TEXT_ALIGN_LABELS[alignment]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div>
          <p className="mb-2 text-sm">Theme</p>
          <ToggleGroup
            data-testid="pref-theme"
            type="single"
            size="sm"
            variant="outline"
            spacing={0}
            value={preferences.theme}
            onValueChange={(value) => value && setPreferences({ theme: value as ReaderTheme })}
            aria-label="Theme"
          >
            {THEME_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div>
          <p className="mb-2 text-sm">Layout</p>
          <ToggleGroup
            data-testid="pref-layout"
            type="single"
            size="sm"
            variant="outline"
            spacing={0}
            value={preferences.layout}
            onValueChange={(value) => value && setPreferences({ layout: value as ReaderLayout })}
            aria-label="Layout"
          >
            {LAYOUT_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {preferences.layout === "paginated" && (
            <div className="mt-2">
              <p className="mb-2 text-sm">Columns</p>
              <ToggleGroup
                data-testid="pref-columns"
                type="single"
                size="sm"
                variant="outline"
                spacing={0}
                value={String(columnCount)}
                onValueChange={(value) => value && setPreferences({ columnCount: Number(value) })}
                aria-label="Column count"
              >
                {EPUB_COLUMN_COUNTS.map((count) => (
                  <ToggleGroupItem key={count} value={String(count)}>
                    {COLUMN_COUNT_LABELS[count]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {/* Page margins are pagination-scoped in the reading system
                  (body padding applies only outside scroll flow). */}
              <div className="mt-3">
                <ScaleSliderRow
                  label="Page margins"
                  sliderTestId="page-gutter"
                  scale={EPUB_PAGE_GUTTER_SCALE_PX}
                  value={nearestEpubPageGutter(preferences.pageGutter)}
                  onStep={(step) => setPreferences({ pageGutter: step })}
                />
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
