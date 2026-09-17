# Security Architecture (#78) Sequencing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the sandboxed parsing architecture from #78 through nine sub-issues in an order that lands the design-independent work first and keeps the worker design pass from blocking everything.

**Architecture:** Phased rollout. Phase 1 hardens existing in-process paths (limits, protocol/IPC, EPUB content policy) so the codebase is safer before the worker exists. Phase 2 designs and builds the sandboxed document worker around the hardened contracts. Phase 3 adds the continuous defenses (corpus tests, fuzzing, supply chain, verification) that assume the earlier layers. Each issue gets its own detailed implementation plan when its phase starts.

**Tech Stack:** Rust (sidecar, workspace crates), TypeScript/Electron (main, preload, renderer), Vitest, cargo test, bubblewrap or Landlock (worker phase), cargo-fuzz.

**Spec:** Umbrella issue
[tuunanet/tuxbooks#78](https://github.com/tuunanet/tuxbooks#78) and its nine
sub-issues #81-#89. Invariant IDs (W-1..W-11, P-1, E-1..E-5, R-1..R-4, T-1..T-7,
X-1..X-5, M-1..M-2, S-1..S-5) are the source of truth; every acceptance
criterion in this plan references them.

## Global Constraints

- Rust is the application/domain language; UI logic in TypeScript; SQL only in `repository/`. Boundaries per `docs/ARCHITECTURE.md`.
- Reader engines behind seams: only `frontend/src/lib/epub/readiumEngine.ts` imports Readium; only `frontend/src/lib/pdf/pdfEngine.ts` imports MuPDF.
- Renderer never sees Node.js; Electron main/preload are plumbing only.
- Run `just check` (or at minimum the relevant test layer) before declaring any task complete; `just format` after touching formatting-sensitive code.
- E2E: never run two E2E invocations concurrently; `just test-e2e` is the safe agent path (see `docs/TESTING.md`).
- Every sub-issue's definition of done includes: invariants listed with IDs, tests or config demonstrating each, update to the relevant `docs/` layer doc, and a note on #78 (closing comment or checkbox) when its invariants are verified.
- Sub-issue bodies are authoritative for scope; this plan sequences them, it does not re-specify them.

---

## Phase Overview

| Phase | Issues                  | Theme                                           |
| ----- | ----------------------- | ----------------------------------------------- |
| 1     | #83, #84, #82           | Harden what exists today, in-process            |
| 2     | #81                     | Design + build the sandboxed worker             |
| 3     | #87, #88, #85, #86, #89 | Continuous defenses, verification, supply chain |

Phase 1 work is deliberately design-independent: none of it waits on the worker
process model decision. Phase 2's design pass resolves the four open decisions
in #78 (worker process model, document handoff, Linux sandbox layer, PDFium
retention) and the hardened contracts from Phase 1 become the worker's
interface requirements.

---

## Phase 1: Harden existing paths

### Task 1: #83 Resource limits (R-1..R-4)

**Why first:** Cheapest to land, immediately bounds every parser path, and its
limits become constants the worker must enforce later. Also unblocks #88
(fuzzing needs limits to distinguish hangs from unbounded work).

**Files (expected, confirm in detail plan):**

- Create: `sidecar/src/limits.rs` (limit table + enforcement helpers)
- Modify: `sidecar/src/epub/` and `sidecar/src/pdf/` parse entry points
- Test: `sidecar/src/limits.rs` unit tests + fixture-based overflow tests

**Invariant coverage:** R-1 (decompression bombs), R-2 (entry/element count caps), R-3 (memory ceilings), R-4 (timeouts with user-facing error).

**Interfaces produced (consumed by #81 and #88):**

- `ResourceLimits { max_decompressed_bytes, max_entries, max_xml_depth, max_parse_seconds, ... }` with a `DEFAULTS` const.
- Enforcement helpers returning typed errors (`LimitExceeded`), not panics.

- [ ] Write detail plan for #83 (`docs/superpowers/plans/`), get approval
- [ ] Implement R-1..R-4 with tests per invariant ID
- [ ] `just test-rust` green; `just check` green
- [ ] Update `docs/DATABASE.md`/`docs/PERFORMANCE.md` if limits interact with reader budgets
- [ ] Close #83 with invariant-by-invariant evidence; tick #78 checklist

### Task 2: #84 tuxbooks:// and path-bearing IPC (T-1..T-7)

**Why second:** The protocol is the boundary attackers actually reach from
renderer compromise; hardening it is design-independent and reduces the blast
radius of everything else. Overlaps with #85 on URL validation but is
landable alone.

**Files (expected, confirm in detail plan):**

- Modify: Electron `main` protocol registration (tuxbooks:// handler)
- Modify: preload bridge surface; renderer call sites
- Test: main-process unit tests + E2E negative tests (traversal, scheme confusion)

**Invariant coverage:** T-1 (path validation), T-2 (scheme/host allowlist), T-3 (no directory traversal), T-4 (no path disclosure in errors), T-5 (single registered protocol), T-6 (no renderer-controlled absolute paths), T-7 (IPC schema validation).

**Interfaces produced:** validated path/query schema shared by main and preload; negative-path test helpers reused by #87.

- [ ] Write detail plan for #84, get approval
- [ ] Implement T-1..T-7 with tests per invariant ID
- [ ] `just check` green; `just test-e2e` green (headless)
- [ ] Update `docs/ARCHITECTURE.md` IPC section
- [ ] Close #84 with evidence; tick #78 checklist

### Task 3: #82 EPUB active content and network fencing (E-1..E-5)

**Why third:** Larger surface than #84 (spine, XHTML, CSS, script tags, external
refs), but builds directly on the validation helpers from Task 2 and the limit
enforcement from Task 1. Enforcement point is `readiumEngine.ts` plus sidecar
pre-parse sanitization.

**Files (expected, confirm in detail plan):**

- Modify: `sidecar/src/epub/` (manifest/spine validation, external-ref detection)
- Modify: `frontend/src/lib/epub/readiumEngine.ts` (CSP, fetch interception)
- Create: `frontend/src/lib/epub/contentPolicy.ts` (single policy module, testable in vitest)
- Test: vitest unit tests + fixture EPUBs with active content

**Invariant coverage:** E-1 (no script execution), E-2 (no external network fetches from content), E-3 (no local file access via content), E-4 (CSS containment), E-5 (plugin/object/embed neutrality).

**Interfaces produced:** `ContentPolicy` module with a `sanitize()`/`validate()` seam both the engine and future worker reuse.

- [ ] Write detail plan for #82, get approval
- [ ] Implement E-1..E-5 with tests per invariant ID
- [ ] `just check` green; manual reader smoke test on a hostile EPUB fixture
- [ ] Update `docs/EPUB.md` policy section
- [ ] Close #82 with evidence; tick #78 checklist

**Phase 1 exit:** R, T, E invariants each have a failing-test-then-passing-test trail; #78 checklist reflects them.

---

## Phase 2: The worker (#81, W-1..W-11 + P-1)

### Task 4: #81 Sandboxed document worker

**Why here:** Now that limits, IPC validation, and content policy exist as
contracts, the worker design pass has real requirements to encode. This is the
largest issue; it resolves the four open decisions from #78 first.

**Key sub-steps:**

1. Design pass (resolve worker process model, handoff mechanism, Linux sandbox layer, PDFium retention) written as an ADR-style doc in `docs/`, referenced from #78.
2. Detail plan from the design; get approval.
3. Implement in invariant order: process spawn/isolation (W-1..W-3), parse handoff (W-4, W-5), crash containment (W-6, W-7), lifecycle (W-8, W-9), then enforcement wiring (W-10, W-11, P-1).
4. Boundary tests from #87's corpus run against the worker.

**Files (expected, confirm in detail plan):**

- Create: worker binary crate or subprocess module in `sidecar/`
- Modify: `sidecar/src` parse entry points to route through worker
- Test: integration tests spawning the worker; corpus fixtures from #87

- [ ] Design doc + open-decision resolution, posted to #81 and #78
- [ ] Detail plan approved
- [ ] Implement W-1..W-11, P-1 with tests per invariant ID
- [ ] `just test-rust` green; `just test-e2e` green
- [ ] Update `docs/ARCHITECTURE.md` process model; `docs/PERFORMANCE.md` budgets
- [ ] Close #81 with evidence; tick #78 checklist

**Phase 2 exit:** Parsing happens only inside the sandboxed worker; #78's "Security boundary goal" holds.

---

## Phase 3: Continuous defenses

Order within Phase 3 is flexible; #85 and #86 can run parallel to #87/#88 if
staffed. #89 is independent and can slot anywhere, but last keeps review
attention on code changes first.

### Task 5: #87 Corpus and boundary tests

**Why first in phase:** Converts invariants into regression armor before fuzzing
amplifies coverage. Worker boundary tests need Task 4 done; the rest only need
Phase 1.

**Invariant coverage:** negative fixtures per E/R/T/W invariant; traversal corpus per T-3; hostile EPUB set per E-1..E-5.

**Interfaces produced:** `fixtures/security/` corpus layout + loader helpers reused by #88.

- [ ] Detail plan approved
- [ ] Corpus checked in; loader + per-invariant negative tests wired into `just test` layers
- [ ] `just check` green; corpus tests green
- [ ] Update `docs/TESTING.md` corpus section
- [ ] Close #87 with evidence; tick #78 checklist

### Task 6: #88 Fuzzing targets

**Why second:** Depends on #83 (limits land first so fuzz hangs are
distinguishable) and benefits from #87's corpus as seeds. Targets: EPUB/ZIP
parsing, XML manifest, PDF object parsing, JSON-RPC boundary.

**Invariant coverage:** demonstrates R and E invariants hold under mutation; feeds crashes into #87's corpus.

- [ ] Detail plan approved (target list + CI cadence, e.g. nightly not per-PR)
- [ ] cargo-fuzz targets for the four parsers; seed corpus from #87
- [ ] Document runbook in `docs/TESTING.md`
- [ ] Close #88 with evidence; tick #78 checklist

### Task 7: #85 Electron hardening verification (X-1..X-5)

**Why third:** Mostly verification/audit of existing config (contextIsolation, sandbox, webSecurity, permission handlers); independent of code changes, so it can also run in parallel earlier if someone is free.

**Invariant coverage:** X-1..X-5 per issue body.

- [ ] Detail plan approved
- [ ] Config audit + production-build verification (packaged app, not dev)
- [ ] Add automated assertions where possible (e.g. a test that inspects packaged BrowserWindow config)
- [ ] Close #85 with evidence; tick #78 checklist

### Task 8: #86 Untrusted metadata and annotations (M-1, M-2)

**Why fourth:** Small; overlaps with #85 on external-link handling. Coordinate so both issues reference the same link-sanitizer.

**Invariant coverage:** M-1 (metadata strings neutralized at render), M-2 (annotation/HTML sanitization).

- [ ] Detail plan approved
- [ ] Implement with tests; reuse link sanitizer from #85 if one exists
- [ ] Close #86 with evidence; tick #78 checklist

### Task 9: #89 Supply chain (S-1..S-5)

**Why last:** No code dependencies, but best done once dependency set is
stabilized by earlier phases so lockfile/audit baselines are meaningful.

**Invariant coverage:** S-1..S-5 per issue body (dependency pinning, audit gating, minimal deps, release provenance, build reproducibility where feasible).

- [ ] Detail plan approved
- [ ] Implement controls; wire audit gate into CI
- [ ] Update `docs/RELEASE.md` and `docs/BUILD.md`
- [ ] Close #89 with evidence; tick #78 checklist

**Phase 3 exit / Definition of done for #78:** all invariant IDs verified with
tests or config, all nine sub-issues closed, `docs/` updated
(ARCHITECTURE, EPUB, PDF, TESTING, RELEASE as applicable), #78 checklist fully
ticked.

---

## Dependency notes (from sub-issue bodies)

- #81: none upstream; but design pass needs Phase 1 contracts to exist to be concrete.
- #82, #83, #84, #85, #89: none upstream.
- #86: coordinate with #85 on external-link handling.
- #87: grows alongside Phase 1; worker boundary tests need #81 done.
- #88: after #83 lands (limits), seeds from #87.
