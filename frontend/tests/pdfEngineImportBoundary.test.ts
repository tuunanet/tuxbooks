// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, test } from "vitest";

/**
 * The engine import boundary (tuxbooks-koe.10, ADR 0002). These cases run the
 * real flat config through ESLint, so a regression in the rule fails the test,
 * not just a config diff. Only the PDF engine adapters under `src/lib/pdf/`
 * may import an engine package or its bundler assets; reader components and
 * the seam must not.
 */

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd: frontendRoot });

// Loading the flat config pulls in the TypeScript parser and the React
// plugins; under the full parallel gate that can outlast vitest's 5s default.
const LINT_TIMEOUT_MS = 30_000;

async function restrictedImports(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, {
    filePath: path.join(frontendRoot, filePath),
  });
  return result!.messages.filter((message) => message.ruleId === "no-restricted-imports");
}

const VIOLATIONS = [
  {
    label: "a reader component importing the mupdf package",
    filePath: "src/components/reader/pdf/ImportBoundaryFixture.ts",
    source: 'import { Document } from "mupdf";\nexport const value = Document;',
  },
  {
    label: "a reader component importing the PDFium package",
    filePath: "src/components/reader/pdf/ImportBoundaryFixture.tsx",
    source: 'import { init } from "@embedpdf/pdfium";\nexport const value = init;',
  },
  {
    label: "the seam importing the MuPDF worker module",
    filePath: "src/lib/pdf/pdfEngine.ts",
    source: 'import url from "./mupdfWorker?worker&url";\nexport default url;',
  },
  {
    label: "the seam importing the MuPDF WASM URL",
    filePath: "src/lib/pdf/pdfEngine.ts",
    source: 'import url from "virtual:mupdf-wasm-url";\nexport default url;',
  },
  {
    label: "the seam importing the PDFium WASM URL",
    filePath: "src/lib/pdf/pdfEngine.ts",
    source: 'import url from "virtual:pdfium-wasm-url";\nexport default url;',
  },
];

const ADAPTERS = [
  {
    label: "the MuPDF asset adapter importing its worker and WASM URL",
    filePath: "src/lib/pdf/mupdfEngine.ts",
    source:
      'import url from "./mupdfWorker?worker&url";\nimport wasm from "virtual:mupdf-wasm-url";\nexport const value = [url, wasm];',
  },
  {
    label: "the MuPDF worker importing the mupdf package",
    filePath: "src/lib/pdf/mupdfWorker.ts",
    source: 'import type { Document } from "mupdf";\nexport type D = Document;',
  },
  {
    label: "the PDFium core importing the PDFium package",
    filePath: "src/lib/pdf/pdfiumCore.ts",
    source: 'import { init } from "@embedpdf/pdfium";\nexport const value = init;',
  },
  {
    label: "the PDFium adapter importing its worker and WASM URL",
    filePath: "src/lib/pdf/pdfiumEngine.ts",
    source:
      'import url from "./pdfiumWorker?worker&url";\nimport wasm from "virtual:pdfium-wasm-url";\nexport const value = [url, wasm];',
  },
];

describe("engine import boundary", () => {
  for (const { label, filePath, source } of VIOLATIONS) {
    test(
      `rejects ${label}`,
      async () => {
        const messages = await restrictedImports(filePath, source);
        expect(messages).toHaveLength(1);
        expect(messages[0]!.ruleId).toBe("no-restricted-imports");
      },
      LINT_TIMEOUT_MS,
    );
  }

  for (const { label, filePath, source } of ADAPTERS) {
    test(
      `allows ${label}`,
      async () => {
        expect(await restrictedImports(filePath, source)).toHaveLength(0);
      },
      LINT_TIMEOUT_MS,
    );
  }

  test(
    "leaves ordinary imports in reader components alone",
    async () => {
      const messages = await restrictedImports(
        "src/components/reader/pdf/ImportBoundaryFixture.ts",
        'import { openPdfDocument } from "@/lib/pdf/pdfEngine";\nexport const value = openPdfDocument;',
      );
      expect(messages).toHaveLength(0);
    },
    LINT_TIMEOUT_MS,
  );
});
