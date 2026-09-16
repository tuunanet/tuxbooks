#!/usr/bin/env node
// Offline supply-chain gate (issue #89). Asserts the repo-side invariants
// the networked audits cannot see: the maturity floor (S-5), the
// build-script allowlist (S-3), the CI audit wiring (S-2), the SBOM wiring
// (S-4), and the pinned nightly fuzz toolchain. Part of `just check` and
// of the npm-audit CI job; `just audit` carries the networked half.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const failures = [];

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// S-2: the audit workflow exists, runs both advisory gates, and carries a
// weekly schedule so advisories are audited continuously, not per-change only.
{
  const wf = read(".github/workflows/audit.yml");
  check("audit workflow exists", wf !== null, ".github/workflows/audit.yml");
  if (wf) {
    check("audit workflow runs the npm gate", wf.includes("npm-audit-gate.mjs"));
    check("audit workflow runs the RustSec gate", wf.includes("install-cargo-audit.sh"));
    check("audit workflow has a schedule", /\bcron:\s*["'][^"']+["']/.test(wf));
  }
}

// Fuzz toolchain pin: a floating nightly is an uncontrolled dependency.
{
  const wf = read(".github/workflows/fuzz.yml");
  check(
    "fuzz workflow pins a dated nightly toolchain",
    wf !== null && /toolchain:\s*nightly-\d{4}-\d{2}-\d{2}/.test(wf ?? ""),
  );
}

// S-4: release builds generate and publish the SBOM.
{
  const wf = read(".github/workflows/release.yml");
  check(
    "release workflow generates and uploads the SBOM",
    wf !== null && wf.includes("just sbom") && wf.includes("SBOM-tuxbooks"),
  );
}

// S-5: the 30-day dependency maturity floor stays in place (recorded
// decision, docs/SUPPLY_CHAIN.md).
{
  const ws = read("pnpm-workspace.yaml");
  const m = ws?.match(/^minimumReleaseAge:\s*(\d+)\s*$/m);
  check(
    "pnpm maturity floor is at least 30 days",
    m !== null && Number(m[1]) >= 43200,
    m ? `minimumReleaseAge: ${m[1]} minutes` : "key missing",
  );
}

// S-3: build/install scripts only run for the reviewed allowlist; anything
// else pnpm blocks must be on the reviewed-ignored list.
{
  const ws = read("pnpm-workspace.yaml") ?? "";
  const allowedToRun = ["esbuild", "electron"];
  const reviewedIgnored = ["electron-winstaller"];
  const block = ws.match(/^onlyBuiltDependencies:\n((?:[ \t]+-.*\n)*)/m);
  const allowed = block ? [...block[1].matchAll(/-\s*(\S+)/g)].map((m) => m[1]) : [];
  const unreviewed = allowed.filter((name) => !allowedToRun.includes(name));
  check(
    "onlyBuiltDependencies matches the reviewed allowlist",
    unreviewed.length === 0,
    unreviewed.length ? `unreviewed: ${unreviewed.join(", ")}` : allowed.join(", "),
  );
  let ignored = [];
  try {
    const out = execFileSync("pnpm", ["ignored-builds"], { encoding: "utf8" });
    const header = out.indexOf("Automatically ignored builds");
    if (header !== -1) {
      for (const line of out.slice(header).split("\n").slice(1)) {
        if (!/^\s{2}\S/.test(line)) break;
        ignored.push(line.trim());
      }
    }
  } catch (err) {
    check("pnpm ignored-builds runs", false, err.message.split("\n")[0]);
  }
  const unreviewedIgnored = ignored.filter((name) => !reviewedIgnored.includes(name));
  check(
    "blocked build scripts match the reviewed-ignored list",
    unreviewedIgnored.length === 0,
    unreviewedIgnored.length
      ? `unreviewed: ${unreviewedIgnored.join(", ")}`
      : ignored.join(", ") || "none",
  );
}

// The audit gate's own logic (fail-on-vulnerable behaviour is exercised
// against inline fixtures, offline).
{
  try {
    execFileSync("node", ["scripts/npm-audit-gate.mjs", "--self-test"], { stdio: "inherit" });
  } catch {
    check("npm audit gate self-test", false, "npm-audit-gate.mjs --self-test failed");
  }
}

if (failures.length > 0) {
  console.error(`supply-chain-gate: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("supply-chain-gate: OK");
