import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * The vendored foliate-js PDF adapter (`foliate-js/pdf.js`) trips Vite's
 * static import analysis and would pull its own bundled PDF.js copy into
 * the app. PDFs are owned by `lib/pdf/pdfEngine.ts`; foliate's adapter is
 * only reachable through a dynamic import we never trigger, so the module
 * is replaced by an empty stub before any transform or scan sees it.
 */
const stubFoliatePdf = {
  name: "tuxbooks:stub-foliate-pdf",
  load(id: string) {
    if (id.split("?", 1)[0]?.endsWith("/foliate-js/pdf.js")) {
      return "export default null;";
    }
    return null;
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), stubFoliatePdf],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "chrome105",
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    css: false,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        // Entry point — the app boot is covered by the E2E suite.
        "src/main.tsx",
        // Sample data for tests/previews, no logic.
        "src/lib/fixtures.ts",
        // Vendored foliate-js submodule.
        "src/lib/epub/foliate-js/**",
        // Engine seams: thin wrappers around the vendored engines, covered
        // end to end by the E2E reader suites (unit tests mock them).
        "src/lib/epub/epubEngine.ts",
        "src/lib/pdf/pdfEngine.ts",
        // Pure type declarations, no runtime code.
        "src/types/**",
        // shadcn/ui primitives: vendored scaffolding, not app logic.
        "src/components/ui/**",
      ],
      reporter: ["text-summary", "html"],
      // Quality gate (docs/coverage.md): per-category floors. Vitest fails
      // the run when any glob drops below its threshold.
      thresholds: {
        "src/App.tsx": { lines: 80 },
        "src/components/library/**": { lines: 80 },
        "src/components/books/**": { lines: 80 },
        "src/components/reader/**": { lines: 80 },
        "src/components/search/**": { lines: 80 },
        "src/components/collections/**": { lines: 100 },
        "src/components/settings/**": { lines: 80 },
        "src/components/layout/**": { lines: 80 },
        "src/state/**": { lines: 80 },
        "src/hooks/**": { lines: 80 },
        "src/lib/**": { lines: 80 },
      },
    },
  },
});
