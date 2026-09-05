declare module "@/lib/epub/foliate-js/view.js" {
  // foliate-js is vendored, untyped JavaScript (pinned git submodule). The
  // engine seam in epubEngine.ts owns all interaction with it; this stub only
  // makes the side-effect import typecheck.
  const view: unknown;
  export default view;
}

declare module "@/lib/epub/foliate-js/overlayer.js" {
  // Stub for the engine's annotation drawing surface, used only through the
  // engine seam. Only the member the seam calls is declared.
  export class Overlayer {
    static highlight(rects: Iterable<DOMRect>, options?: { color?: string }): SVGElement;
  }
}
