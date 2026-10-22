import { defineConfig } from "vite-plus";

/**
 * Workspace-wide toolchain config (lint + format). Per the Vite+ monorepo
 * model, `vp lint` / `vp fmt` / `vp check` read these blocks from the
 * workspace root and package configs cannot replace them; file- or
 * package-specific settings go in the overrides below. The app's dev/build/
 * test config stays in frontend/vite.config.ts.
 */

/**
 * Engine import boundary (ADR 0002): only the PDF engine adapters under
 * `frontend/src/lib/pdf/` may import an engine package or its bundler
 * assets. Reader components depend on the seam's re-exported types and
 * helpers, so an engine-specific workaround cannot leak back into the
 * reader and one engine can be replaced without touching reader code.
 */
const ENGINE_IMPORT_PATTERNS = [
  {
    group: ["@embedpdf/pdfium", "@embedpdf/pdfium/*"],
    message: "Import the PDF engine only through the pdfEngine seam.",
  },
  {
    group: ["virtual:pdfium-wasm-url"],
    message: "Engine WASM URLs are resolved inside the engine adapter.",
  },
  {
    group: ["*pdfiumWorker*"],
    message: "Engine workers are started inside the engine adapter.",
  },
];

export default defineConfig({
  // Carried over from the removed .prettierrc.json: printWidth 100. The
  // remaining options there (semi, double quotes, trailing commas) are the
  // formatter defaults, so they need no entry.
  fmt: {
    printWidth: 100,
  },
  lint: {
    // Enforcement scope carried over from the ESLint era: only frontend/
    // was linted. electron/, e2e/, and scripts/ are covered by tsc
    // typechecking (justfile `typecheck`), and root tests/ holds generated
    // fixtures — none of them were ESLint clients before this migration.
    ignorePatterns: [
      "electron/**",
      "e2e/**",
      "scripts/**",
      "tests/**",
      "oracle/**",
      "vendor/**",
      ".worktrees/**",
      "frontend/dist/**",
      // Static assets: never linted in the ESLint era (it matched only
      // **/*.{ts,tsx}); plain scripts served as-is.
      "frontend/public/**",
      // Vendored third-party code (pinned foliate-js submodule): upstream
      // JavaScript consumed as-is through the engine seam.
      "frontend/src/lib/epub/foliate-js/**",
    ],
    env: {
      browser: true,
    },
    // ESLint-era mapping: @eslint/js + typescript-eslint recommended sets
    // map to Oxlint's default correctness categories plus the typescript
    // plugin; eslint-plugin-react-hooks (rules-of-hooks, exhaustive-deps)
    // ships inside the react plugin, at the same warn level its
    // recommended config used. The react-refresh plugin has no Oxlint
    // equivalent yet, so only-export-components enforcement is dropped
    // (retired with the shadcn suppressions, see docs/STANDARDS.md).
    plugins: ["typescript", "react"],
    rules: {
      // Carried over from the ESLint era's TSAnyKeyword selector via
      // no-restricted-syntax: 'any' is not allowed without an explicit
      // escape comment explaining why. Oxlint has no no-restricted-syntax,
      // so the canonical TS rule enforces it instead.
      "typescript/no-explicit-any": "error",
      "no-restricted-imports": ["error", { patterns: ENGINE_IMPORT_PATTERNS }],
    },
    overrides: [
      {
        // The engine adapters are the only modules allowed to import an
        // engine package or its bundler assets; every other file gets the
        // restriction above. The workers are included so the engine-side
        // modules can reach their engine; the main-thread adapters own the
        // worker URL and WASM URL. The __engine_boundary_adapters__ fixtures
        // stand in for the adapters in tests/pdfEngineImportBoundary.test.ts,
        // which proves the allowance without touching real adapter files.
        files: [
          "frontend/src/lib/pdf/pdfiumCore.ts",
          "frontend/src/lib/pdf/pdfiumEngine.ts",
          "frontend/src/lib/pdf/pdfiumWorker.ts",
          "frontend/src/lib/pdf/__engine_boundary_adapters__/**",
        ],
        rules: {
          "no-restricted-imports": "off",
        },
      },
    ],
  },
});
