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
  },
});
