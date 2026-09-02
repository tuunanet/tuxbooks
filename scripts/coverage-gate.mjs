#!/usr/bin/env node
/**
 * Rust coverage gate (docs/coverage.md): runs cargo-llvm-cov and enforces
 * the per-module line-coverage floors. Exits non-zero when any module is
 * below its floor. The raw report is at target/llvm-cov/coverage.json.
 *
 * Not wired into `just check` on purpose: the instrumented build lives in
 * its own target dir, so the first run (and any run after a dependency
 * change) pays a full rebuild. Run it via `just coverage` when touching a
 * module's behavior or tests.
 *
 * Commands/, lib.rs, error.rs and main.rs are outside the gate: they are
 * the IPC boundary, wiring, and entry point — all covered end to end by
 * the E2E suite (see docs/coverage.md).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const MODULES = {
  epub: 80,
  pdf: 80,
  services: 80,
  repository: 80,
  db: 80,
  domain: 80,
};

const report = "target/llvm-cov/coverage.json";
mkdirSync("target/llvm-cov", { recursive: true });
execFileSync(
  "cargo",
  [
    "llvm-cov",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--features",
    "custom-protocol",
    "--json",
    "--output-path",
    report,
  ],
  { stdio: "inherit" },
);

const cov = JSON.parse(readFileSync(report, "utf8"));
const byModule = {};
for (const f of cov.data[0].files) {
  const idx = f.filename.indexOf("/src-tauri/src/");
  if (idx === -1) continue;
  const rel = f.filename.slice(idx + "/src-tauri/src/".length);
  const module = rel.includes("/") ? rel.split("/")[0] : null;
  if (!module || !(module in MODULES)) continue;
  byModule[module] ??= { covered: 0, total: 0 };
  byModule[module].covered += f.summary.lines.covered;
  byModule[module].total += f.summary.lines.count;
}

let failed = false;
console.log("\nmodule        lines   required  status");
for (const [module, floor] of Object.entries(MODULES)) {
  const { covered, total } = byModule[module] ?? { covered: 0, total: 0 };
  const pct = total > 0 ? (covered / total) * 100 : 100;
  const ok = pct >= floor;
  if (!ok) process.exitCode = 1;
  console.log(
    module.padEnd(14) +
      `${covered}/${total}`.padEnd(12) +
      `${floor}%`.padEnd(10) +
      (ok ? "PASS" : `FAIL (${pct.toFixed(1)}%)`),
  );
}
