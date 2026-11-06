import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  effectiveReaderTheme,
  readReaderSettings,
  subscribeReaderSettings,
} from "@/lib/readerSettings";
import {
  appThemeScope,
  readerThemeScope,
  ThemeScopeProvider,
  themeScopeStyle,
} from "@/lib/themeScope";
import { cn } from "@/lib/utils";
import { useAppDispatch, useAppState } from "@/state/appState";
import { useThemeState } from "@/state/themeState";
import { SettingsShell } from "./SettingsShell";

/** Keeps the window clear of the viewport edge while dragging. */
const DRAG_MARGIN = 12;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  limitX: number;
  limitY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Panel size against the app window, not fixed: a percentage of the viewport
 * scales live with resizes; the floor keeps small windows from shrinking the
 * panel below its former fixed size, the ceiling keeps it a window rather
 * than a sheet on huge monitors, and the 2rem gutter keeps it clear of the
 * edge. One definition feeds both the size classes and the position clamp,
 * so they can never disagree about how big the panel is.
 */
const PANEL_SIZE: CSSProperties & Record<`--${string}`, string> = {
  "--settings-w": "min(max(920px,72vw),1440px,calc(100vw - 2rem))",
  "--settings-h": "min(max(680px,78vh),960px,calc(100vh - 2rem))",
};

/**
 * The Settings window: a modal floating panel over whatever view is open, so
 * settings stay reachable from the library and from a book. The header strips
 * marked `data-settings-drag-handle` drag the panel inside the viewport;
 * Escape and the close button dismiss it.
 */
export function SettingsWindow() {
  const app = useAppState();
  const dispatch = useAppDispatch();
  const { resolvedTheme } = useThemeState();
  const open = app.settingsOpen;
  const readerSettings = useSyncExternalStore(
    subscribeReaderSettings,
    readReaderSettings,
    readReaderSettings,
  );
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Opened over the reader, the window paints with the reader's live surface
  // theme instead of the app theme underneath it. The scope derives from the
  // same store the reader renders from, so a pinned theme, an auto theme
  // following an app flip, and a Viewer-settings edit all stay in sync.
  const themeScope = useMemo(
    () =>
      app.view === "reader"
        ? readerThemeScope(effectiveReaderTheme(readerSettings, resolvedTheme))
        : appThemeScope(),
    [app.view, readerSettings, resolvedTheme],
  );
  const themeStyle = useMemo(() => themeScopeStyle(themeScope), [themeScope]);

  // Reopening starts centered again instead of wherever the last drag ended.
  const close = useCallback(() => {
    setOffset({ x: 0, y: 0 });
    setDragging(false);
    dispatch({ type: "close-settings" });
  }, [dispatch]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (!target.closest("[data-settings-drag-handle]")) return;
    // Buttons and form controls inside a header keep their own click behavior.
    if (target.closest("button, a, input, select, textarea, [role='button']")) return;

    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect) return;

    const limitX = Math.max(0, (window.innerWidth - rect.width) / 2 - DRAG_MARGIN);
    const limitY = Math.max(0, (window.innerHeight - rect.height) / 2 - DRAG_MARGIN);

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // A window resize leaves the stored offset outside the new limits.
      // Start from where the panel is actually drawn, or the first drag
      // after a resize moves nothing until the pointer covers the gap.
      baseX: clamp(offset.x, -limitX, limitX),
      baseY: clamp(offset.y, -limitY, limitY),
      limitX,
      limitY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset({
      x: clamp(drag.baseX + event.clientX - drag.startX, -drag.limitX, drag.limitX),
      y: clamp(drag.baseY + event.clientY - drag.startY, -drag.limitY, drag.limitY),
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // While the window is open it owns every key: the reader's shortcut
  // registry listens on window, so keydowns are stopped at the dialog unless
  // they are Escape. Escape keeps bubbling to Radix's document listener so
  // the dialog closes, then stops there before the registry sees it.
  return (
    <ThemeScopeProvider scope={themeScope} style={themeStyle}>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent
          ref={contentRef}
          data-testid="settings-window"
          showCloseButton={false}
          aria-describedby={undefined}
          overlayClassName="bg-black/40 backdrop-blur-sm supports-backdrop-filter:backdrop-blur-sm"
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key !== "Escape") event.stopPropagation();
          }}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          // The clamp is what keeps a stale drag offset from leaving the
          // panel off-screen: the app window can shrink under it (maximize,
          // drag to a corner, restore) and the stored pixels no longer fit
          // the viewport. The browser re-evaluates the clamp on every
          // resize, so no resize listener can lag behind.
          style={{
            ...PANEL_SIZE,
            left: `clamp(calc(var(--settings-w) / 2 + ${DRAG_MARGIN}px), calc(50% + ${offset.x}px), calc(100% - var(--settings-w) / 2 - ${DRAG_MARGIN}px))`,
            top: `clamp(calc(var(--settings-h) / 2 + ${DRAG_MARGIN}px), calc(50% + ${offset.y}px), calc(100% - var(--settings-h) / 2 - ${DRAG_MARGIN}px))`,
          }}
          className={cn(
            "block h-[var(--settings-h)] w-[var(--settings-w)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none",
            "rounded-2xl shadow-2xl",
            dragging && "cursor-grabbing select-none",
          )}
        >
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <SettingsShell onClose={close} />
        </DialogContent>
      </Dialog>
    </ThemeScopeProvider>
  );
}
