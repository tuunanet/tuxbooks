import { useEffect, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** The OS reduced-motion preference as of this call. */
export function systemPrefersReducedMotion(win: Window): boolean {
  return win.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

/**
 * The OS reduced-motion preference, live. The book view reads it and
 * passes the flag into its turn adapter (spec tuxbooks-9pr → Reduced
 * motion): consumers of the flag never read the media query themselves.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => systemPrefersReducedMotion(window));
  useEffect(() => {
    const media = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!media) return;
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  return reduced;
}
