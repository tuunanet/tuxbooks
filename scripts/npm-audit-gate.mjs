#!/usr/bin/env node
// npm audit gate (issue #89, S-2): fails on npm advisories at or above
// HIGH severity unless they carry a triage entry below. Runs against the
// pnpm workspace lockfile (dev dependencies included: electron, vite and
// friends are exactly the packages that execute at build time). Policy and
// procedure: docs/SUPPLY_CHAIN.md.
import { execFileSync } from "node:child_process";

const SEVERITY_RANK = { low: 1, moderate: 2, high: 3, critical: 4 };
const BLOCK_AT = "high";

// Triage list: advisories accepted with a reason and a revisit date.
// Match by npm advisory id (bulk advisory format) or package name. Only
// entries in this list keep the gate green; everything else at or above
// BLOCK_AT fails. Add an entry only when no viable upgrade exists.
const TRIAGE = [
  // { id: "GHSA-example-0000", module: "package-name", reason: "...", revisit: "2027-01-01" },
];

// Returns { blocked, accepted, informational } for the bulk advisory JSON
// (`pnpm audit --json`). `triage` defaults to the real list; --self-test
// injects its own.
export function evaluate(advisories, triage = TRIAGE) {
  const blocked = [];
  const accepted = [];
  const informational = [];
  for (const a of Object.values(advisories ?? {})) {
    const severity = a.severity ?? "unknown";
    const triaged = triage.some((t) => t.id === a.id || t.module === a.module_name);
    if (triaged) accepted.push(a);
    else if ((SEVERITY_RANK[severity] ?? 0) >= SEVERITY_RANK[BLOCK_AT]) blocked.push(a);
    else informational.push(a);
  }
  blocked.sort((x, y) => (x.module_name ?? "").localeCompare(y.module_name ?? ""));
  return { blocked, accepted, informational };
}

// Shape guard for the `pnpm audit --json` report. A missing or malformed
// advisories key is a tool error (exit 2), never an empty audit: pnpm has
// moved audit output before, and silently reading zero advisories would
// fail the gate open exactly when the output format changed under us.
export function extractAdvisories(report) {
  const advisories = report?.advisories;
  if (advisories === null || typeof advisories !== "object" || Array.isArray(advisories)) {
    throw new Error("unexpected pnpm audit --json shape: no advisories object");
  }
  return advisories;
}

function selfTest() {
  const cases = [
    { name: "clean audit passes", advisories: {}, triage: [], wantBlocked: 0 },
    {
      name: "untriaged high severity fails",
      advisories: { 1: { id: 1, module_name: "left-pad", severity: "high", title: "fixture" } },
      triage: [],
      wantBlocked: 1,
    },
    {
      name: "untriaged critical fails",
      advisories: { 2: { id: 2, module_name: "evil", severity: "critical", title: "fixture" } },
      triage: [],
      wantBlocked: 1,
    },
    {
      name: "low severity is informational",
      advisories: { 3: { id: 3, module_name: "minor", severity: "low", title: "fixture" } },
      triage: [],
      wantBlocked: 0,
    },
    {
      name: "triaged advisory passes",
      advisories: { 1: { id: 1, module_name: "left-pad", severity: "high", title: "fixture" } },
      triage: [{ id: 1, module: "left-pad", reason: "fixture", revisit: "2027-01-01" }],
      wantBlocked: 0,
    },
    {
      name: "triage on another package does not mask",
      advisories: { 1: { id: 1, module_name: "left-pad", severity: "high", title: "fixture" } },
      triage: [{ id: 9, module: "other", reason: "fixture", revisit: "2027-01-01" }],
      wantBlocked: 1,
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = evaluate(c.advisories, c.triage).blocked.length;
    if (got !== c.wantBlocked) {
      console.error(`FAIL ${c.name}: want ${c.wantBlocked} blocked, got ${got}`);
      failed++;
    } else {
      console.log(`ok   ${c.name}`);
    }
  }
  const shapeCases = [
    {
      name: "advisories object passes the shape guard",
      report: { advisories: {} },
      wantThrow: false,
    },
    { name: "missing advisories key is a tool error", report: {}, wantThrow: true },
    { name: "null advisories is a tool error", report: { advisories: null }, wantThrow: true },
    { name: "array advisories is a tool error", report: { advisories: [] }, wantThrow: true },
  ];
  for (const c of shapeCases) {
    let threw = false;
    try {
      extractAdvisories(c.report);
    } catch {
      threw = true;
    }
    if (threw !== c.wantThrow) {
      console.error(`FAIL ${c.name}`);
      failed++;
    } else {
      console.log(`ok   ${c.name}`);
    }
  }
  return failed;
}

/** Run pnpm audit and return the parsed report; tool failures exit 2. */
function runAudit() {
  let raw;
  try {
    raw = execFileSync("pnpm", ["audit", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // pnpm audit exits nonzero when it finds vulnerabilities; the parsed
    // report still arrives on stdout. Only a parse/run failure is a tool
    // error (exit 2).
    if (err.stdout) return JSON.parse(err.stdout);
    console.error("npm-audit-gate: pnpm audit failed to run:", err.message);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("npm-audit-gate: could not parse pnpm audit --json output");
    process.exit(2);
  }
}

/** Parse the audit report into advisory records; malformed output exits 2. */
function readAdvisories() {
  try {
    return extractAdvisories(runAudit());
  } catch (err) {
    console.error(`npm-audit-gate: ${err.message}`);
    process.exit(2);
  }
}

function main() {
  if (process.argv.includes("--self-test")) {
    process.exit(selfTest() === 0 ? 0 : 1);
  }
  const advisories = readAdvisories();
  const { blocked, accepted, informational } = evaluate(advisories);
  for (const a of accepted) {
    console.log(`triaged: ${a.module_name} ${a.severity} ${a.title ?? ""}`);
  }
  for (const a of informational) {
    console.log(`info:    ${a.module_name} ${a.severity} ${a.title ?? ""} (${a.url ?? "no url"})`);
  }
  if (blocked.length > 0) {
    for (const a of blocked) {
      console.error(
        `BLOCKED  ${a.module_name} ${a.severity}: ${a.title ?? ""} (${a.url ?? "no url"})`,
      );
      console.error(
        `         fix via: pnpm update ${a.module_name} — or triage in scripts/npm-audit-gate.mjs`,
      );
    }
    console.error(`npm-audit-gate: ${blocked.length} untriaged finding(s) at or above ${BLOCK_AT}`);
    process.exit(1);
  }
  console.log("npm-audit-gate: no untriaged high or critical findings");
}

main();
