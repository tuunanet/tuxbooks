#!/usr/bin/env node
/**
 * Coverage badge generator (docs/plans/coverage-badge-plan.md): reads the
 * vitest json-summary report and emits a shields.io endpoint JSON with the
 * gate's real number — the worst per-category lines coverage — plus the
 * overall percentage. Run after a `--coverage` run; CI publishes the output
 * to the badges branch on main pushes only, so the badge only ever shows
 * numbers from green runs (the vitest thresholds already fail the run below
 * any category floor — docs/coverage.md).
 *
 * Usage: node scripts/coverage-badge.mjs [summaryPath] [outPath]
 *   defaults: frontend/coverage/coverage-summary.json
 *            -> frontend/coverage/coverage-badge.json
 *
 * The category globs deliberately mirror frontend/vite.config.ts
 * coverage.thresholds (duplicated on purpose — this list may drift only in
 * the same change as the thresholds, the PR #12/#21 weld rule).
 */
import { readFileSync, writeFileSync } from "node:fs";

const CATEGORIES = [
  ["App shell", ["src/App.tsx", "src/components/layout/"]],
  ["Library view", ["src/components/library/"]],
  ["Book cards/detail", ["src/components/books/"]],
  ["Reader", ["src/components/reader/"]],
  ["Search", ["src/components/search/"]],
  ["Collections", ["src/components/collections/"]],
  ["Settings", ["src/components/settings/"]],
  ["State providers", ["src/state/"]],
  ["Hooks", ["src/hooks/"]],
  ["Frontend lib", ["src/lib/"]],
];

export function worstCategory(summary) {
  const byCategory = {};
  for (const [file, data] of Object.entries(summary)) {
    const idx = file.indexOf("/frontend/");
    if (idx === -1) continue;
    const rel = file.slice(idx + "/frontend/".length);
    for (const [name, prefixes] of CATEGORIES) {
      if (prefixes.some((p) => rel.startsWith(p) || rel === p.replace(/\/$/, ""))) {
        byCategory[name] ??= { covered: 0, total: 0 };
        byCategory[name].covered += data.lines.covered;
        byCategory[name].total += data.lines.total;
      }
    }
  }
  let worst = null;
  for (const [name, { covered, total }] of Object.entries(byCategory)) {
    if (total === 0) continue;
    const pct = (covered / total) * 100;
    if (!worst || pct < worst.pct) worst = { name, pct };
  }
  return { worst, overall: summary.total?.lines.pct ?? 0 };
}

const [summaryArg, outArg] = process.argv.slice(2);
const summaryPathArg = summaryArg ?? "frontend/coverage/coverage-summary.json";
const outPath = outArg ?? "frontend/coverage/coverage-badge.json";

const summary = JSON.parse(readFileSync(summaryPathArg, "utf8"));
const { worst, overall } = worstCategory(summary);

if (!worst) {
  console.error("no files matched any category — summary path or globs drifted");
  process.exit(1);
}

const w = Math.floor(worst.pct);
const o = Math.floor(overall);
const color = w >= 90 ? "brightgreen" : w >= 80 ? "green" : "yellow";
const badge = {
  schemaVersion: 1,
  label: "coverage",
  message: `${w}% (min cat ${worst.name}) · ${o}% overall`,
  color,
  maxAge: 86400,
};

writeFileSync(outPath, JSON.stringify(badge));
console.log(JSON.stringify(badge));
