import { useState } from "react";
import { NotebookPen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { clampBookmarkLabel } from "@/lib/annotationLocation";
import type { AnnotationPatch } from "@/types/domain";
import type { Annotation } from "@/types/domain";
import { HIGHLIGHT_COLOR_KEYS } from "@/lib/highlightPalette";

interface ReaderAnnotationListProps {
  annotations: Annotation[];
  /** Shows the color dot and the color swatches (highlights). */
  withColor: boolean;
  /** Resolves a persisted palette slot to the active theme family's wash. */
  colorFor: (color: string | null | undefined) => string;
  /** One-line title of a row ("Page 3", a chapter label, …). */
  label: (annotation: Annotation) => string;
  /** Optional second line, e.g. a bookmark's location when it has a label. */
  subLabel?: (annotation: Annotation) => string | null;
  onJump: (annotation: Annotation) => void;
  onDelete: (id: number) => void;
  onUpdate: (id: number, patch: AnnotationPatch) => void;
  /** Prefix for row test ids: `${prefix}-${index}`. */
  testIdPrefix: string;
}

/**
 * Rows of persistent annotations (bookmarks or highlights) with per-row
 * label (bookmarks) and note editing, optional recoloring, deletion, and
 * jump-to-position. Shared by the navigation drawer's Bookmarks and
 * Highlights tabs.
 */
export function ReaderAnnotationList({
  annotations,
  withColor,
  colorFor,
  label,
  subLabel,
  onJump,
  onDelete,
  onUpdate,
  testIdPrefix,
}: ReaderAnnotationListProps) {
  const [editing, setEditing] = useState<{
    id: number;
    note: string;
    label: string | null;
  } | null>(null);

  const saveEdit = () => {
    if (!editing) return;
    onUpdate(editing.id, {
      ...(editing.label !== null ? { label: editing.label } : {}),
      note: editing.note,
    });
    setEditing(null);
  };

  return (
    <ScrollArea className="h-full px-2 pr-2">
      {annotations.map((annotation, index) => (
        <div
          key={annotation.id}
          data-testid={`${testIdPrefix}-${index}`}
          className="rounded-md px-1 py-1.5 hover:bg-accent/60"
        >
          <div className="flex items-center gap-1.5">
            {withColor && (
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full border border-black/20"
                data-testid={`${testIdPrefix}-color-${index}`}
                style={{ background: colorFor(annotation.color) }}
              />
            )}
            <button
              type="button"
              data-testid={`${testIdPrefix}-jump-${index}`}
              onClick={() => onJump(annotation)}
              className="min-w-0 flex-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="block truncate text-sm">{label(annotation)}</span>
              {subLabel?.(annotation) && (
                <span className="block truncate text-xs text-muted-foreground">
                  {subLabel(annotation)}
                </span>
              )}
              {annotation.text && (
                <span className="block truncate text-xs text-muted-foreground">
                  {annotation.text}
                </span>
              )}
              {annotation.note && (
                <span className="block truncate text-xs italic text-muted-foreground">
                  {annotation.note}
                </span>
              )}
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              data-testid={`${testIdPrefix}-note-${index}`}
              aria-label={
                annotation.kind === "bookmark"
                  ? "Edit bookmark label and note"
                  : annotation.note
                    ? "Edit note"
                    : "Add note"
              }
              onClick={() =>
                setEditing((current) =>
                  current?.id === annotation.id
                    ? null
                    : {
                        id: annotation.id,
                        note: annotation.note ?? "",
                        label: annotation.kind === "bookmark" ? (annotation.label ?? "") : null,
                      },
                )
              }
            >
              <NotebookPen />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              data-testid={`${testIdPrefix}-delete-${index}`}
              aria-label="Delete annotation"
              onClick={() => {
                if (editing?.id === annotation.id) setEditing(null);
                onDelete(annotation.id);
              }}
            >
              <Trash2 />
            </Button>
          </div>
          {editing?.id === annotation.id && (
            <div className="mt-1 space-y-2 pb-1 pl-1">
              {withColor && (
                <div
                  className="flex items-center gap-1.5"
                  data-testid={`${testIdPrefix}-swatches-${index}`}
                >
                  {HIGHLIGHT_COLOR_KEYS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Change highlight color to ${color}`}
                      title={`Change highlight color to ${color}`}
                      onClick={() => onUpdate(annotation.id, { color })}
                      className="size-4 rounded-full border border-black/20 outline-none hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50"
                      style={{ background: colorFor(color) }}
                    />
                  ))}
                </div>
              )}
              {editing.label !== null && (
                <label className="block text-xs font-medium text-muted-foreground">
                  Bookmark label
                  <input
                    data-testid="annotation-label-input"
                    aria-label="Bookmark label"
                    value={editing.label}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        label: clampBookmarkLabel(event.target.value),
                      })
                    }
                    placeholder="Short description"
                    className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                </label>
              )}
              <textarea
                data-testid="annotation-note-input"
                aria-label="Note"
                rows={3}
                value={editing.note}
                onChange={(event) => setEditing({ ...editing, note: event.target.value })}
                className="w-full rounded-md border bg-transparent p-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="annotation-note-cancel"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
                <Button size="sm" data-testid="annotation-note-save" onClick={saveEdit}>
                  {editing.label !== null ? "Save" : "Save note"}
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
      <ScrollBar />
    </ScrollArea>
  );
}
