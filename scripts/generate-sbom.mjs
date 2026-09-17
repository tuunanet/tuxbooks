#!/usr/bin/env node
// CycloneDX 1.5 SBOM / dependency inventory (issue #89, S-4). The npm tree
// comes from `pnpm -r list --json` (prod + dev: dev-only packages execute
// at build time and are part of the supply chain); the Rust tree comes
// from `cargo tree` over the sidecar workspace's normal dependency edges.
// The fuzz crate is local tooling and is not inventoried. `just sbom` runs
// this; release.yml publishes the result with the release artifacts.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function collectNpm() {
  const raw = execFileSync("pnpm", ["-r", "list", "--json", "--depth", "Infinity"], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    cwd: root,
  });
  const found = new Map();
  const walk = (tree) => {
    for (const [name, node] of Object.entries(tree ?? {})) {
      if (node?.version) found.set(`${name}@${node.version}`, { name, version: node.version });
      walk(node?.dependencies);
      walk(node?.devDependencies);
    }
  };
  for (const project of JSON.parse(raw)) {
    walk(project.dependencies);
    walk(project.devDependencies);
  }
  return [...found.values()];
}

function collectCargo() {
  const raw = execFileSync(
    "cargo",
    [
      "tree",
      "--manifest-path",
      "sidecar/Cargo.toml",
      "--edges",
      "normal",
      "--prefix",
      "none",
      "--charset",
      "ascii",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, cwd: root },
  );
  const found = new Map();
  for (const line of raw.split("\n")) {
    const m = line.match(/^(\S+) v(\S+)/);
    if (!m || m[1] === "tuxbooks") continue;
    found.set(`${m[1]}@${m[2]}`, { name: m[1], version: m[2] });
  }
  return [...found.values()];
}

function npmPurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

function buildBom(npmPackages, cargoPackages, timestamp) {
  const components = [
    ...npmPackages.map((p) => ({
      type: "library",
      name: p.name,
      version: p.version,
      purl: npmPurl(p.name, p.version),
    })),
    ...cargoPackages.map((p) => ({
      type: "library",
      name: p.name,
      version: p.version,
      purl: `pkg:cargo/${p.name}@${p.version}`,
    })),
  ].sort((a, b) => a.purl.localeCompare(b.purl));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp,
      tools: {
        components: [
          { type: "application", name: "tuxbooks-generate-sbom", version: packageJson.version },
        ],
      },
      component: { type: "application", name: "tuxbooks", version: packageJson.version },
    },
    components,
  };
}

function selfTest() {
  const bom = buildBom(
    [
      { name: "left-pad", version: "1.0.0" },
      { name: "@scope/pkg", version: "2.0.0" },
    ],
    [{ name: "serde", version: "1.0.219" }],
    "2026-09-16T00:00:00.000Z",
  );
  const fail = (msg) => {
    console.error(`FAIL ${msg}`);
    return 1;
  };
  let failed = 0;
  if (bom.bomFormat !== "CycloneDX" || bom.specVersion !== "1.5") failed += fail("bom header");
  if (bom.components.length !== 3) failed += fail("component count");
  if (bom.components[0].purl !== "pkg:cargo/serde@1.0.219")
    failed += fail("cargo purl / sort order");
  if (bom.components[1].purl !== "pkg:npm/%40scope%2Fpkg@2.0.0")
    failed += fail("scoped purl encoding");
  if (bom.components[2].purl !== "pkg:npm/left-pad@1.0.0") failed += fail("npm purl");
  if (bom.metadata.component.version !== packageJson.version)
    failed += fail("root component version");
  if (failed === 0) console.log("ok   sbom self-test (header, purls, sort, root component)");
  return failed;
}

function main() {
  if (process.argv.includes("--self-test")) process.exit(selfTest() === 0 ? 0 : 1);
  const npmPackages = collectNpm();
  const cargoPackages = collectCargo();
  const outDir = path.join(root, "dist-packages");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `SBOM-tuxbooks-${packageJson.version}.cdx.json`);
  writeFileSync(
    outFile,
    `${JSON.stringify(buildBom(npmPackages, cargoPackages, new Date().toISOString()), null, 2)}\n`,
  );
  console.log(
    `SBOM: ${npmPackages.length} npm + ${cargoPackages.length} cargo components -> ${path.relative(root, outFile)}`,
  );
}

main();
