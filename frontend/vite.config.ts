import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";

/**
 * Emits the MuPDF WASM bundle as a build asset and serves it in dev,
 * exposing its URL through a virtual module. The package does not export
 * the file as a subpath, and the emscripten glue's own resolution (relative
 * to the worker chunk) never finds it in a bundled build — the seam passes
 * the URL to the worker explicitly (docs/pdf.md).
 */
const wasmFile = path.resolve(import.meta.dirname, "node_modules/mupdf/dist/mupdf-wasm.wasm");
const mupdfWasmUrl: Plugin = {
  name: "tuxbooks:mupdf-wasm-url",
  resolveId(id: string) {
    return id === "virtual:mupdf-wasm-url" ? id : null;
  },
  load(id: string): string | null {
    if (id !== "virtual:mupdf-wasm-url") return null;
    if (this.environment.config.command === "build") {
      const reference: string = this.emitFile({
        type: "asset",
        name: "mupdf-wasm.wasm",
        originalFileName: wasmFile,
        source: fs.readFileSync(wasmFile),
      });
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    }
    return `export default "/@fs${wasmFile.split("?")[0]}";`;
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), mupdfWasmUrl],
  clearScreen: false,
  // Electron loads the built renderer over file:// — absolute asset URLs
  // would resolve to the filesystem root, so assets must stay relative.
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/sidecar/**"],
    },
  },
  build: {
    target: "chrome105",
    outDir: "dist",
    // The entry chunk (~520 kB) is the always-loaded app shell: React,
    // radix primitives, and every bookshelf surface. Reader engines (epub,
    // mobi, pdf, …) already ship as lazy per-format chunks — the MuPDF WASM
    // in particular only loads when a PDF opens. Chunks come from local
    // disk, not the network, so ~0.5 MB minified is immaterial here; the
    // raised limit keeps Vite quiet while still flagging runaway growth.
    chunkSizeWarningLimit: 600,
  },
  // The MuPDF worker is an ES module (it dynamic-imports the engine inside
  // the worker context); the default IIFE worker format cannot.
  worker: {
    format: "es",
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
        // Engine seams: thin wrappers around the engines, covered
        // end to end by the E2E reader suites (unit tests mock them).
        "src/lib/epub/readiumEngine.ts",
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
