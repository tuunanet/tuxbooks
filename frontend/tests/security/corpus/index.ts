/**
 * Security corpus index (issue #87): what each invariant's negative vectors
 * are and where the enforcement tests live. Already-landed tests are
 * pointed at, not duplicated; the corpus test below pins this inventory so
 * deleting a vector class or an owning test breaks the build.
 */

export interface CorpusRow {
  invariant: string;
  /** Vector home: the exported arrays that make up the hostile input. */
  vectors: string;
  /** Tests (and where) that assert the vectors fail closed. */
  enforcedBy: string[];
}

export const SECURITY_CORPUS: readonly CorpusRow[] = [
  {
    invariant: "E-1",
    vectors: "SCRIPTED_HTML_SNIPPETS, UNSUPPORTED_ENCODING_PROLOGS, corpus/hostileEpub.ts",
    enforcedBy: [
      "tests/security/contentPolicy.test.ts (sanitization, frame CSP, encoding prologs)",
      "tests/security/corpus/corpus.test.ts (hostile EPUB documents through the fence)",
      "sidecar/tests/security_corpus.rs::hostile_epub_fails_typed_through_the_worker",
      "e2e/specs/epub-content-security.e2e.ts (scripted book fails to open)",
    ],
  },
  {
    invariant: "E-2",
    vectors: "ACTIVE_CONTENT_HTML_SNIPPETS, corpus/hostileEpub.ts",
    enforcedBy: [
      "tests/security/contentPolicy.test.ts (active-element neutralization, frame belt)",
      "tests/security/corpus/corpus.test.ts (hostile EPUB documents through the fence)",
      "e2e/specs/epub-content-security.e2e.ts (no iframe/object/embed in mounted frames)",
    ],
  },
  {
    invariant: "E-3",
    vectors: "EXTERNAL_RESOURCE_URLS, DANGEROUS_SCHEME_HREFS, corpus/hostileEpub.ts",
    enforcedBy: [
      "tests/security/contentPolicy.test.ts (href classification, policy fetch client)",
      "tests/security/corpus/corpus.test.ts (hostile EPUB beacons rejected before fetch)",
      "sidecar/src/epub/session.rs tests (remote/scheme spine hrefs fail the session)",
      "e2e/specs/epub-content-security.e2e.ts (no external round trip completes)",
    ],
  },
  {
    invariant: "E-4",
    vectors: "corpus/hostileEpub.ts (path-probe book)",
    enforcedBy: [
      "tests/security/contentPolicy.test.ts (publicationBaseUrl opaque book id)",
      "sidecar/src/epub/session.rs::session_documents_leak_no_filesystem_paths_e4",
      "e2e/specs/epub-content-security.e2e.ts (no home paths in session documents)",
    ],
  },
  {
    invariant: "E-5",
    vectors: "TRAVERSAL_MEMBER_PATHS, ENCODED_TRAVERSAL_MEMBERS, DOUBLE_ENCODED_TRAVERSAL_MEMBERS",
    enforcedBy: [
      "tests/security/pathSchema.test.ts (member path normalization, fail closed)",
      "tests/security/protocolHandler.test.ts (400 on encoded traversal, 404 on double)",
      "sidecar/src/epub/session.rs::read_member_rejects_hostile_member_paths_e5",
      "sidecar/tests/security_corpus.rs::hostile_member_path_fails_typed_through_the_worker",
    ],
  },
  {
    invariant: "R-1",
    vectors: "sidecar/tests/fixtures/security/hostile_epub.rs (runtime builders)",
    enforcedBy: [
      "sidecar/src/limits.rs tests (every quota helper)",
      "sidecar/src/epub/parser.rs + session.rs tests (parse-path quota trips)",
      "sidecar/tests/security_corpus.rs (compressed member, deep paths, zip shapes, entity abuse, inert fonts/covers)",
    ],
  },
  {
    invariant: "R-2",
    vectors: "sidecar/tests/fixtures/security/hostile_pdf.rs (runtime builders)",
    enforcedBy: [
      "sidecar/src/pdf/parser.rs tests (pages, node/depth budgets, metadata caps)",
      "sidecar/tests/security_corpus.rs (malformed xref shapes, cyclic page tree, decompression bomb containment, bounded hostile render)",
    ],
  },
  {
    invariant: "R-3",
    vectors: "expired deadlines, read_bounded lying streams",
    enforcedBy: [
      "sidecar/src/limits.rs tests (deadline, read_bounded)",
      "sidecar/src/epub/parser.rs::parse_epub_rejects_expired_deadline",
      "sidecar/src/pdf/parser.rs + render.rs deadline tests",
    ],
  },
  {
    invariant: "T-1",
    vectors: "ABSOLUTE_COVER_PATHS, BAD_BOOK_IDS",
    enforcedBy: [
      "tests/security/protocolHandler.test.ts (cover names only, invalid ids 400)",
      "tests/security/ipcPolicy.test.ts (main-issued paths only)",
    ],
  },
  {
    invariant: "T-2",
    vectors: "SCHEME_CONFUSION_URLS, BAD_BOOK_IDS, TRAVERSAL_MEMBER_PATHS",
    enforcedBy: [
      "tests/security/protocolHandler.test.ts (scheme/host allowlist)",
      "tests/security/pathSchema.test.ts (id and member-path schema)",
      "tests/security/corpus/corpus.test.ts (traversal corpus through parseMemberPath, ids through parseBookId)",
    ],
  },
  {
    invariant: "T-3",
    vectors: "TRAVERSAL_MEMBER_PATHS, ABSOLUTE_COVER_PATHS",
    enforcedBy: [
      "tests/security/protocolHandler.test.ts (traversal corpus, cover names never paths)",
      "tests/security/pathSchema.test.ts (parseMemberPath, parseCoverName)",
      "tests/security/corpus/corpus.test.ts (traversal corpus through parseMemberPath, cover paths through parseCoverName)",
    ],
  },
  {
    invariant: "T-4",
    vectors: "fixed MIME table, spoofed wire media types",
    enforcedBy: [
      "tests/security/protocolHandler.test.ts (fixed MIME, no path disclosure in 500 bodies)",
    ],
  },
  {
    invariant: "T-5",
    vectors: "preload surface enumeration",
    enforcedBy: ["tests/security/preloadSurface.test.ts (no generic passthrough)"],
  },
  {
    invariant: "T-6",
    vectors: "unknown methods, malformed params, oversized payloads",
    enforcedBy: [
      "tests/security/ipcPolicy.test.ts (unknown method, oversized params)",
      "sidecar/src/rpc.rs tests (method-not-found, malformed JSON lines ignored, service stays alive)",
      "sidecar/tests/worker_containment.rs (response cap, not a hang)",
    ],
  },
  {
    invariant: "T-7",
    vectors: "un-issued paths per path-bearing method",
    enforcedBy: [
      "tests/security/ipcPolicy.test.ts (scan_library, import_paths, reconnect_book, set_book_cover, book ids, offsets)",
    ],
  },
  {
    invariant: "W-8",
    vectors: "deadline killers, rlimit SIGXCPU, flooded responses, tight quota jobs",
    enforcedBy: [
      "sidecar/tests/worker_containment.rs (deadline kill, rlimit mapping, flood cap, quota trip)",
    ],
  },
  {
    invariant: "W-9",
    vectors: "SEGV worker, missing binary, hostile documents",
    enforcedBy: [
      "sidecar/tests/worker_containment.rs (crash typed, restart works, sidecar survives)",
      "sidecar/tests/security_corpus.rs (hostile input through the worker, worker recovers)",
    ],
  },
  {
    invariant: "W-2/W-3/W-5",
    vectors: "real-worker Landlock selftest denials",
    enforcedBy: [
      "sidecar/tests/worker_sandbox.rs (open denied, socket denied, fds 0-3 only)",
      "sidecar/tests/security_corpus.rs (hostile documents never widen the worker's reach)",
    ],
  },
  {
    invariant: "P-1",
    vectors: "sidecar/tests/fixtures/security/hostile_pdf.rs through the worker",
    enforcedBy: [
      "sidecar/tests/worker_ops.rs (pdf parse/properties/cover in the worker)",
      "sidecar/tests/security_corpus.rs (hostile pdf fails typed through the worker, recovers)",
    ],
  },
];
