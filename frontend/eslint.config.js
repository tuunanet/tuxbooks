import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

/**
 * Engine import boundary (ADR 0002): only the PDF engine adapters under
 * `src/lib/pdf/` may import an engine package or its bundler assets. Reader
 * components depend on the seam's re-exported types and helpers, so an
 * engine-specific workaround cannot leak back into the reader and one engine
 * can be replaced without touching reader code.
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

export default tseslint.config(
  // Vendored third-party code (pinned foliate-js submodule) is not linted —
  // it is upstream JavaScript consumed as-is through the engine seam.
  { ignores: ["dist", "node_modules", "src/lib/epub/foliate-js/**"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAnyKeyword",
          message: "'any' is not allowed without an explicit escape comment explaining why.",
        },
      ],
      "no-restricted-imports": ["error", { patterns: ENGINE_IMPORT_PATTERNS }],
    },
  },
  {
    // The engine adapters are the only modules allowed to import an engine
    // package or its bundler assets; every other file gets the restriction
    // above. The workers are included so the engine-side modules can reach
    // their engine; the main-thread adapters own the worker URL and WASM URL.
    files: [
      "src/lib/pdf/pdfiumCore.ts",
      "src/lib/pdf/pdfiumEngine.ts",
      "src/lib/pdf/pdfiumWorker.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
