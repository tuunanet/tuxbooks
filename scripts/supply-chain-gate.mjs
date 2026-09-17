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

if (process.argv.includes("--self-test")) process.exit(selfTest() === 0 ? 0 : 1);

// Capture the list lines of a top-level YAML key, up to the next
// top-level key. Comment and blank lines inside the block are skipped,
// which matters: a comment directly after the key must not end the
// capture (the first version of this parser stopped there and silently
// matched zero entries, making the allowlist assertion inert).
// `key` is a plain identifier (no regex metacharacters).
function parseListBlock(yaml, key) {
  const keyLine = new RegExp(`^${key}:(\\s|$)`);
  let found = false;
  const entries = [];
  for (const line of yaml.split("\n")) {
    if (!found) {
      if (keyLine.test(line)) found = true;
      continue;
    }
    if (/^\S/.test(line)) break; // the next top-level key ends the block
    const item = line.match(/^\s+-\s+(\S+)/);
    if (item) entries.push(item[1].replace(/^["']|["']$/g, ""));
  }
  return { found, entries };
}

// Problems with the onlyBuiltDependencies allowlist relative to the
// reviewed set. A present-but-unparseable block is a problem too: the
// real allowlist is never empty, so zero entries means the parser lost
// the list (or someone emptied it).
function allowlistProblems(yaml, reviewed) {
  const { found, entries } = parseListBlock(yaml, "onlyBuiltDependencies");
  const problems = [];
  if (!found) problems.push("onlyBuiltDependencies key missing");
  else if (entries.length === 0) problems.push("onlyBuiltDependencies parsed to zero entries");
  for (const entry of entries) {
    if (!reviewed.includes(entry)) problems.push(`unreviewed allowlist entry: ${entry}`);
  }
  return problems;
}

function selfTest() {
  const reviewed = ["esbuild", "electron"];
  const clean = [
    "packages:",
    "  - frontend",
    "onlyBuiltDependencies:",
    "  # esbuild needs its platform binary",
    "  - esbuild",
    "  # electron downloads the runtime binary",
    "  - electron",
    "minimumReleaseAge: 43200",
    "",
  ].join("\n");
  const tampered = clean.replace("  - electron\n", "  - electron\n  - supply-evil\n");
  const cases = [
    { name: "allowlist entries survive leading comments", yaml: clean, want: [] },
    {
      name: "extra allowlisted entry is flagged",
      yaml: tampered,
      want: ["unreviewed allowlist entry: supply-evil"],
    },
    {
      name: "missing key is flagged",
      yaml: clean.replace(/^onlyBuiltDependencies:\n[\s\S]*?(?=minimumReleaseAge)/m, ""),
      want: ["onlyBuiltDependencies key missing"],
    },
    {
      name: "comment-only block is flagged",
      yaml: clean.replace(
        "  - esbuild\n  # electron downloads the runtime binary\n  - electron\n",
        "",
      ),
      want: ["onlyBuiltDependencies parsed to zero entries"],
    },
    {
      name: "block ends at the next top-level key",
      yaml: `${clean}  - supply-evil\n`,
      want: [],
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = allowlistProblems(c.yaml, reviewed);
    const complete = c.want.every((w) => got.includes(w)) && got.length === c.want.length;
    if (!complete) {
      console.error(`FAIL ${c.name}: want [${c.want.join("; ")}], got [${got.join("; ")}]`);
      failed++;
    } else {
      console.log(`ok   ${c.name}`);
    }
  }
  const quoted = parseListBlock(
    'onlyBuiltDependencies:\n  - "@scope/pkg" # why\n',
    "onlyBuiltDependencies",
  );
  if (quoted.entries.length !== 1 || quoted.entries[0] !== "@scope/pkg") {
    console.error(
      `FAIL quoted and inline-commented entries parse: got [${quoted.entries.join(", ")}]`,
    );
    failed++;
  } else {
    console.log("ok   quoted and inline-commented entries parse");
  }
  return failed;
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
  const problems = allowlistProblems(ws, allowedToRun);
  check(
    "onlyBuiltDependencies matches the reviewed allowlist",
    problems.length === 0,
    problems.length ? problems.join("; ") : "esbuild, electron",
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

// The gates' own logic (fail-on-vulnerable behaviour is exercised against
// inline fixtures, offline).
{
  const failed = selfTest();
  check(
    "supply-chain-gate parse self-test",
    failed === 0,
    failed ? `${failed} case(s) failed` : "",
  );
}
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
