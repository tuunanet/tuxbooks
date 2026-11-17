#!/usr/bin/env node
// Per-file explanatory comment budget (tuxbooks-hxl).
//
// Counts comment lines in tracked Rust and TypeScript files and enforces a
// flat cap of CAP. A file already over the cap at the merge base may stay at
// or below its base count, but may not grow. Doc comments, lint directives,
// SAFETY blocks, and shebangs do not count.
//
// Modes:
//   --base <ref>              working tree versus the merge base
//   --base <ref> --head <ref> the change since the merge base (pre-push, CI)
//   --all [--report]          every tracked source file, flat cap only
//   --explain <file>          print every counted and exempt comment line
//   --self-test               fixture tests for the lexers and budget math
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAP, budgetFor, countSource, parseOverride } from "./comment-budget-scan.mjs";

const SOURCE_FILE = /\.(?:rs|ts|tsx)$/;
const EXCLUDED_PATH = [
  /(?:^|\/)(?:node_modules|dist|target|vendor)\//,
  /(?:^|\/)tests\/fixtures\//,
  /\.config\.ts$/,
];

function isSourcePath(path) {
  return SOURCE_FILE.test(path) && !EXCLUDED_PATH.some((pattern) => pattern.test(path));
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readBlob(base, path) {
  try {
    return git(["show", `${base}:${path}`]);
  } catch {
    return null;
  }
}

function listChanged(base, head) {
  const args = ["diff", "--name-status", "-z", "-M", "--diff-filter=AMRT", base];
  if (head) args.push(head);
  const fields = git(args).split("\0");
  const changes = [];
  for (let at = 0; at < fields.length;) {
    const status = fields[at++];
    if (!status) continue;
    if (status[0] === "R") {
      changes.push({ status: status[0], from: fields[at++], to: fields[at++] });
    } else {
      changes.push({ status: status[0], path: fields[at++] });
    }
  }
  if (!head) {
    for (const path of git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) {
      if (path) changes.push({ status: "A", path });
    }
  }
  return changes;
}

function checkChanges(base, head) {
  const failures = [];
  let checked = 0;
  for (const change of listChanged(base, head)) {
    const path = change.to || change.path;
    if (!isSourcePath(path)) continue;
    const added = change.status === "A";
    const baseSource = added ? null : readBlob(base, change.from || change.path);
    const currentSource = head ? readBlob(head, path) : readFileSync(resolve(path), "utf8");
    if (currentSource === null) {
      failures.push(`${path}: could not read the file at ${head}`);
      continue;
    }
    checked++;
    const current = countSource(currentSource, path);
    const baseCount =
      baseSource === null ? null : countSource(baseSource, change.from || path).count;
    const override = parseOverride(currentSource);
    const budget = budgetFor(baseCount, added || baseSource === null, override);
    if (budget.error) {
      failures.push(`${path}: ${budget.error}`);
      continue;
    }
    if (current.count > budget.allowed) {
      const overrideNote = override?.budget === undefined ? "" : `, override ${override.budget}`;
      const origin =
        baseCount === null
          ? `cap ${CAP}, base none${overrideNote}`
          : `cap ${CAP}, base ${baseCount}${overrideNote}`;
      failures.push(`${path}: ${current.count} comment lines (${origin})`);
    }
  }
  return { failures, checked };
}

function allFiles() {
  const files = [];
  for (const path of git(["ls-files", "-z", "*.rs", "*.ts", "*.tsx"]).split("\0")) {
    if (path && isSourcePath(path)) files.push(path);
  }
  return files;
}

function checkAll(report) {
  // No base revision is available here, so this mode applies the flat cap
  // only. The ratchet and the new-file overrides are gate-only.
  const rows = [];
  for (const path of allFiles()) {
    const source = readFileSync(resolve(path), "utf8");
    const current = countSource(source, path);
    const override = parseOverride(source);
    rows.push({ path, count: current.count, error: override?.error });
  }
  rows.sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
  const failures = rows.filter((row) => row.error || row.count > CAP);
  if (report) {
    console.log(`comment budget report (cap ${CAP}, ${rows.length} files)`);
    for (const row of rows) {
      if (row.error) console.log(`  error  ${row.path}: ${row.error}`);
      else if (row.count > CAP) console.log(`  ${String(row.count).padStart(4)}  ${row.path}`);
    }
    const over = rows.filter((row) => row.count > CAP).length;
    console.log(
      `${over} file(s) over ${CAP}; counted lines: ${rows.reduce((sum, row) => sum + row.count, 0)}`,
    );
    return { failures: [], checked: rows.length };
  }
  return {
    failures: failures.map(
      (row) => `${row.path}: ${row.error || `${row.count} comment lines (cap ${CAP})`}`,
    ),
    checked: rows.length,
  };
}

function explain(path) {
  const source = readFileSync(resolve(path), "utf8");
  const result = countSource(source, path);
  console.log(`${path}: ${result.count} counted line(s), cap ${CAP}`);
  for (const comment of result.comments) {
    const label = comment.kind === "explanatory" ? "counted" : `exempt:${comment.kind}`;
    console.log(
      `  ${String(comment.startLine).padStart(4)}-${String(comment.endLine).padEnd(4)} ${label}  ${comment.text.split("\n")[0]}`,
    );
  }
}

function selfTest() {
  const cases = [
    ["ts line comment", "ts", ["// why", "const x = 1;"], 1],
    ["ts trailing comment", "ts", ["const x = 1; // why"], 1],
    ["ts doc block", "ts", ["/**", " * docs", " */", "const x = 1;"], 0],
    ["ts explanatory block", "ts", ["/*", " why", " */"], 3],
    ["ts template literal", "ts", ["const s = `", "// not a comment", "`;"], 0],
    ["ts template expression", "ts", ["const s = `${", "  // counted", "  1}`;"], 1],
    ["ts string", "ts", ['const s = "// not a comment";'], 0],
    ["ts regex with quotes", "ts", ["const re = /[\"']/; // counted"], 1],
    ["ts regex at line start", "ts", ["/[\"']/.test(value); // counted"], 1],
    ["ts regex escapes", "ts", ["const re = /https?:\\/\\//;"], 0],
    ["ts division", "ts", ["const half = value / 2; // counted"], 1],
    ["ts shebang", "ts", ["#!/usr/bin/env node", "// counted"], 1],
    [
      "ts disable directive",
      "ts",
      ["// eslint-disable-next-line no-console", "console.log(1);"],
      0,
    ],
    ["ts triple-slash reference", "ts", ['/// <reference types="node" />'], 0],
    ["ts eslint-env directive", "ts", ["// eslint-env node"], 0],
    ["ts ts-check directive", "ts", ["// @ts-check"], 0],
    ["ts block directive", "ts", ["/* eslint-disable no-console */"], 0],
    ["ts multiline block directive", "ts", ["/*", " * eslint-disable no-console", " */"], 0],
    ["rust block safety", "rs", ["/* SAFETY: valid */"], 0],
    ["rust line comment", "rs", ["// why", "fn main() {}"], 1],
    ["rust doc comments", "rs", ["/// docs", "//! module docs", "fn main() {}"], 0],
    ["rust nested block", "rs", ["/*", " outer", " /* inner */", " outer", "*/"], 5],
    ["rust raw string", "rs", ['let s = r#"', "// not a comment", '"#;'], 0],
    ["rust char and lifetime", "rs", ["fn f<'a>(x: &'a char) { let c = '/'; }"], 0],
    ["rust safety block", "rs", ["// SAFETY: valid", "// because reasons", "unsafe { }"], 0],
    ["ts code plus block", "ts", ["const x = 1; /* why */"], 1],
    ["tsx jsx apostrophe", "tsx", ["const view = <p>Don't panic</p>; // counted"], 1],
    ["tsx jsx double quotes", "tsx", ['const view = <p>He said "hi"</p>; // counted'], 1],
    ["tsx jsx url", "tsx", ["const view = <p>See https://example.com/x</p>;"], 0],
    [
      "tsx jsx url and comment",
      "tsx",
      ["const view = <p>See https://example.com/x</p>; // counted"],
      1,
    ],
    ["ts comment after colon", "ts", ["case 1:// why"], 1],
    ["ts unterminated string", "ts", ["const s = 'no close", "// counted"], 1],
    ["rust multiline string", "rs", ['let s = "', "// not a comment", '";', "// counted"], 1],
  ];
  let failed = 0;
  for (const [name, language, lines, want] of cases) {
    const fixture =
      language === "rs" ? "fixture.rs" : language === "tsx" ? "fixture.tsx" : "fixture.ts";
    const got = countSource(lines.join("\n"), fixture).count;
    if (got !== want) {
      console.error(`FAIL  ${name}: expected ${want}, got ${got}`);
      failed++;
    }
  }

  const overrides = [
    ["valid override", "// comment-budget: 15 because split from a legacy file", 15],
    ["missing reason", "// comment-budget: 15", "error"],
    ["over the maximum", "// comment-budget: 21 because too high", "error"],
    ["duplicate", "// comment-budget: 12 because one\n// comment-budget: 13 because two", "error"],
    ["too late", "1\n2\n3\n4\n5\n// comment-budget: 12 because late", "error"],
  ];
  for (const [name, source, want] of overrides) {
    const got = parseOverride(source);
    const okay = want === "error" ? Boolean(got?.error) : got?.budget === want;
    if (!okay) {
      console.error(`FAIL  ${name}: got ${JSON.stringify(got)}`);
      failed++;
    }
  }

  const budgets = [
    ["legacy file keeps its count", budgetFor(40, false, null).allowed === 40],
    ["clean file gets the cap", budgetFor(5, false, null).allowed === CAP],
    ["new file override", budgetFor(null, true, { budget: 15 }).allowed === 15],
    ["new file override below the cap", budgetFor(null, true, { budget: 5 }).allowed === 5],
    ["existing clean file cannot raise", Boolean(budgetFor(5, false, { budget: 15 }).error)],
    ["legacy override does not raise", budgetFor(40, false, { budget: 20 }).allowed === 40],
  ];
  for (const [name, okay] of budgets) {
    if (!okay) {
      console.error(`FAIL  ${name}`);
      failed++;
    }
  }

  if (failed === 0) {
    console.log(
      `ok    comment budget self-test (${cases.length + overrides.length + budgets.length} cases)`,
    );
  }
  return failed === 0;
}

function usage() {
  console.log(`usage: comment-budget-gate.mjs --base <ref> [--head <ref>] [--quiet]
       comment-budget-gate.mjs --all [--report]
       comment-budget-gate.mjs --explain <file>
       comment-budget-gate.mjs --self-test

The change is measured from the merge base of --base and --head.`);
}

const FLAG_OPTIONS = {
  "--all": "all",
  "--report": "report",
  "--self-test": "selfTest",
  "--quiet": "quiet",
};
const VALUE_OPTIONS = {
  "--base": "base",
  "--head": "head",
  "--explain": "explain",
};

function parseOptions(args) {
  const options = {
    base: null,
    head: null,
    all: false,
    report: false,
    explain: null,
    selfTest: false,
    quiet: false,
  };
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (VALUE_OPTIONS[arg]) {
      const value = args[++at];
      if (value === undefined) return { error: `${arg} needs a value` };
      options[VALUE_OPTIONS[arg]] = value;
    } else if (FLAG_OPTIONS[arg]) {
      options[FLAG_OPTIONS[arg]] = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return { options };
}

function checkBase(options) {
  if (!options.base) {
    console.error("comment-budget-gate: --base, --all, --explain, or --self-test is required");
    return null;
  }
  const base = git(["merge-base", options.base, options.head || "HEAD"]).trim();
  return checkChanges(base, options.head);
}

function runMain() {
  const parsed = parseOptions(process.argv.slice(2));
  if (parsed.help) {
    usage();
    return 0;
  }
  if (parsed.error) {
    console.error(parsed.error);
    usage();
    return 2;
  }

  const options = parsed.options;
  if (options.selfTest) return selfTest() ? 0 : 1;
  const explainPath = options.explain ? resolve(options.explain) : null;
  process.chdir(git(["rev-parse", "--show-toplevel"]).trim());
  if (explainPath) {
    explain(explainPath);
    return 0;
  }

  const result = options.all || options.report ? checkAll(options.report) : checkBase(options);
  if (result === null) {
    usage();
    return 2;
  }
  if (result.failures.length > 0) {
    console.error(`comment budget: ${result.failures.length} file(s) over budget (cap ${CAP})`);
    for (const failure of result.failures) console.error(`  ${failure}`);
    console.error(
      "Doc comments and directives are exempt; --explain <file> lists the counted lines.",
    );
    return 1;
  }
  if (!options.quiet && !options.report) {
    console.log(
      result.checked === 0
        ? `comment budget: OK (no changed Rust/TypeScript files, cap ${CAP})`
        : `comment budget: OK (${result.checked} file(s), cap ${CAP})`,
    );
  }
  return 0;
}

function main() {
  try {
    return runMain();
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    console.error(`comment-budget-gate: ${detail}`);
    return 2;
  }
}

process.exitCode = main();
