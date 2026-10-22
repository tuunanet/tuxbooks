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
  // Task definitions for Vite Task (`vp run`). Tasks are cached by default
  // (package.json scripts are not): automatic input tracking records what
  // each command actually reads, a changed input forces a real re-run, and
  // an unchanged tree replays the recorded output. Use
  // `pnpm exec vp run --no-cache <task>` to bypass, and `vp cache clean`
  // to reset. The commands mirror the pre-task justfile lines exactly so
  // cache-keyed behavior matches what ran before the indirection.
  run: {
    tasks: {
      "frontend:build": {
        command: "pnpm --filter frontend build",
        cache: {
          // The e2e suites write artifacts/ into the workspace root during
          // a run, which would change this task's fingerprint mid-run and
          // cost one redundant real build per fresh runner. The build never
          // reads that directory.
          input: [{ auto: true }, "!artifacts/**"],
        },
      },
      "frontend:test": {
        command:
          "pnpm --filter frontend exec vp test run --coverage --testTimeout=15000 --maxWorkers=6",
        cache: {
          // The coverage tooling both reads and writes under
          // frontend/coverage/ within a single run (a random-named remap
          // file in coverage/.tmp, plus probes of previously generated
          // report pages), which would flag every run as "modified its
          // inputs". Nothing treats coverage artifacts as inputs, so they
          // are out of input tracking; writes stay tracked (minus the
          // pointless random-named temp dir), so a cache hit restores the
          // html report and summary. Note a replayed run restores the
          // cached run's artifacts, not fresh ones. The engine-boundary
          // fixtures are likewise written and lint-read within the run
          // (tests/pdfEngineImportBoundary.test.ts), so they stay out of
          // input tracking too.
          input: [
            { auto: true },
            "!frontend/coverage/**",
            "!frontend/tests/fixtures/engine-boundary/**",
          ],
          output: [
            { auto: true },
            "!frontend/coverage/.tmp/**",
            // The boundary fixtures are deleted again before the task ends;
            // restoring their recorded writes on a replay would resurrect
            // violation fixtures onto disk and fail repo-wide lint.
            "!frontend/tests/fixtures/engine-boundary/**",
          ],
        },
      },
    },
  },
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
        // worker URL and WASM URL. The fixtures under tests/fixtures/
        // engine-boundary/ stand in for the adapters in
        // tests/pdfEngineImportBoundary.test.ts, which proves the allowance
        // without touching real adapter files (which other tests import
        // concurrently).
        files: [
          "frontend/src/lib/pdf/pdfiumCore.ts",
          "frontend/src/lib/pdf/pdfiumEngine.ts",
          "frontend/src/lib/pdf/pdfiumWorker.ts",
          "frontend/tests/fixtures/engine-boundary/adapters/**",
        ],
        rules: {
          "no-restricted-imports": "off",
        },
      },
    ],
  },
});
