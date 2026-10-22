// @vitest-environment node
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vite-plus/test";

/**
 * The engine import boundary (tuxbooks-koe.10, ADR 0002). These cases run the
 * real Oxlint config through `vp lint`, so a regression in the rule fails the
 * test, not just a config diff. Only the PDF engine adapters under
 * `src/lib/pdf/` may import an engine package or its bundler assets; reader
 * components and the seam must not.
 *
 * Probes are written to dedicated fixture paths — the adapter override in the
 * root vite.config.ts covers `src/lib/pdf/__engine_boundary_adapters__/**` so
 * the allowance can be proven without touching the real adapter files (which
 * other tests import concurrently). Fixture sources carry `// @ts-nocheck`
 * so a file left behind by a crashed run cannot break `tsc` (the synthetic
 * `virtual:pdfium-wasm-url` import has no type declaration); the next run of
 * this file deletes leftovers before writing.
 */

const execFileAsync = promisify(execFile);

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const vpBin = fileURLToPath(new URL("../node_modules/.bin/vp", import.meta.url));

// Spawning vp per case is cheap (Oxlint starts in milliseconds), but the
// first run can pay binary warmup; the old ESLint-era budget is kept.
const LINT_TIMEOUT_MS = 30_000;

const touchedDirs = new Set<string>();

function cleanFixtureDir(relativePath: string) {
  const dir = path.dirname(path.join(frontendRoot, relativePath));
  touchedDirs.add(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function restrictedImportsFired(relativePath: string, source: string) {
  cleanFixtureDir(relativePath);
  const absolute = path.join(frontendRoot, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  // @ts-nocheck keeps a crashed-run leftover harmless to tsc; oxlint reads
  // comments as whitespace for rule purposes.
  fs.writeFileSync(absolute, `// @ts-nocheck\n${source}`);
  try {
    const { stdout, stderr } = await execFileAsync(vpBin, ["lint", relativePath], {
      cwd: frontendRoot,
      timeout: LINT_TIMEOUT_MS,
    });
    return diagnose(`${stdout}\n${stderr}`);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return diagnose(`${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
  }
}

/** Counts no-restricted-imports diagnostics; each finding prints one line. */
function diagnose(output: string) {
  const findings = output.match(/no-restricted-imports\):/g)?.length ?? 0;
  return { findings, output };
}

afterAll(() => {
  for (const dir of touchedDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const VIOLATIONS = [
  {
    label: "a reader component importing the PDFium package",
    filePath: "src/components/reader/pdf/__engine_boundary__/fixture.tsx",
    source: 'import { init } from "@embedpdf/pdfium";\nexport const value = init;',
  },
  {
    label: "the seam importing the PDFium worker module",
    filePath: "src/lib/pdf/__engine_boundary_seam__/fixture.ts",
    source: 'import url from "./pdfiumWorker?worker&url";\nexport default url;',
  },
  {
    label: "the seam importing the PDFium WASM URL",
    filePath: "src/lib/pdf/__engine_boundary_seam__/fixture.ts",
    source: 'import url from "virtual:pdfium-wasm-url";\nexport default url;',
  },
];

const ADAPTERS = [
  {
    label: "the PDFium core importing the PDFium package",
    filePath: "src/lib/pdf/__engine_boundary_adapters__/pdfiumCore.ts",
    source: 'import { init } from "@embedpdf/pdfium";\nexport const value = init;',
  },
  {
    label: "the PDFium adapter importing its worker and WASM URL",
    filePath: "src/lib/pdf/__engine_boundary_adapters__/pdfiumEngine.ts",
    source:
      'import url from "./pdfiumWorker?worker&url";\nimport wasm from "virtual:pdfium-wasm-url";\nexport const value = [url, wasm];',
  },
];

describe("engine import boundary", () => {
  for (const { label, filePath, source } of VIOLATIONS) {
    test(
      `rejects ${label}`,
      async () => {
        const { findings, output } = await restrictedImportsFired(filePath, source);
        expect(findings, output).toBe(1);
      },
      LINT_TIMEOUT_MS,
    );
  }

  for (const { label, filePath, source } of ADAPTERS) {
    test(
      `allows ${label}`,
      async () => {
        const { findings, output } = await restrictedImportsFired(filePath, source);
        expect(findings, output).toBe(0);
      },
      LINT_TIMEOUT_MS,
    );
  }

  test(
    "leaves ordinary imports in reader components alone",
    async () => {
      const { findings, output } = await restrictedImportsFired(
        "src/components/reader/pdf/__engine_boundary__/fixture.ts",
        'import { openPdfDocument } from "@/lib/pdf/pdfEngine";\nexport const value = openPdfDocument;',
      );
      expect(findings, output).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );
});
