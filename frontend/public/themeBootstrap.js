// Applies the stored theme before any bundle runs so startup never
// flashes the wrong theme. Mirrors src/lib/theme.ts, keep in sync:
// only exact "light"/"dark" count; anything else follows the OS.
// Static file (frontend/public) rather than an inline script so the app
// CSP's script-src 'self' (issue #85 X-2) covers it without a hash pin.
(() => {
  var stored = null;
  try {
    stored = localStorage.getItem("tuxbooks.theme");
  } catch (error) {
    // Storage unavailable: follow the OS.
  }
  var dark =
    stored === "dark" || (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
