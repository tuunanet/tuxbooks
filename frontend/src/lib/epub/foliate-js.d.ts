declare module "@/lib/epub/foliate-js/view.js" {
  // foliate-js is vendored, untyped JavaScript (pinned git submodule). The
  // engine seam in epubEngine.ts owns all interaction with it; this stub only
  // makes the side-effect import typecheck.
  const view: unknown;
  export default view;
}
