import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

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
    },
  },
);
