import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react";
import {
  epubSurfaceTheme,
  epubThemeColorScheme,
  readerThemeVariables,
  type ReaderTheme,
} from "@/lib/epub/appearance";
/**
 * The theme a surface paints with. App scopes use the document tokens; reader
 * scopes override the same tokens from the reader preset. One scope type keeps
 * the library, the reader, and every portaled overlay on one vocabulary.
 */
export type ThemeScope = { kind: "app" } | { kind: "reader"; theme: ReaderTheme };

export function appThemeScope(): ThemeScope {
  return { kind: "app" };
}

/**
 * A reader preset as a scope. The neutral default keeps the app chrome, so it
 * resolves to the app scope instead of pinning a light surface.
 */
export function readerThemeScope(theme: ReaderTheme): ThemeScope {
  return epubSurfaceTheme(theme) === "default" ? appThemeScope() : { kind: "reader", theme };
}

/**
 * Token overrides and native control scheme for a scope. The app scope needs
 * neither: the document already carries its tokens and `color-scheme`.
 */
export function themeScopeStyle(scope: ThemeScope): CSSProperties {
  if (scope.kind === "app") return {};
  const surface = epubSurfaceTheme(scope.theme);
  return {
    ...(readerThemeVariables(surface) ?? {}),
    colorScheme: epubThemeColorScheme(surface),
  } as CSSProperties;
}

/**
 * Explicit style for a reader-themed surface that renders outside the reader
 * root (a popover or sheet). The neutral default returns an empty style so the
 * app tokens keep control.
 */
export function readerThemeStyle(theme: ReaderTheme): CSSProperties {
  return themeScopeStyle(readerThemeScope(theme));
}

const ThemeScopeContext = createContext<CSSProperties | null>(null);

export function ThemeScopeProvider({
  scope,
  style,
  children,
}: {
  scope: ThemeScope;
  /** Precomputed `themeScopeStyle(scope)` when the caller also needs it. */
  style?: CSSProperties;
  children: ReactNode;
}) {
  const value = useMemo(() => style ?? themeScopeStyle(scope), [scope, style]);
  return <ThemeScopeContext.Provider value={value}>{children}</ThemeScopeContext.Provider>;
}

/**
 * The active scope's token style merged under a component's own inline style.
 * Portaled primitives call this so a dialog or tooltip opened from the reader
 * does not fall back to the app's light/dark mode.
 */
export function useThemeScopeStyle(style?: CSSProperties): CSSProperties | undefined {
  const scopeStyle = useContext(ThemeScopeContext);
  if (!scopeStyle && !style) return undefined;
  return { ...scopeStyle, ...style };
}
