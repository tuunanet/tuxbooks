# ADR 0011: Disable the EPUB book-mode rotation turn in Stage 1

Status: accepted
Date: 2026-10-27
Decides: whether the EPUB book-mode turn animates in Stage 1, and what any future animated EPUB turn has to solve
Relates to: spec `tuxbooks-9pr`, `tuxbooks-9pr.7`, `tuxbooks-2ir`, `docs/EPUB.md`, pagecurl-gl `docs/research/tuxbooks-integration-findings.md`

## Context

Stage 1 gave EPUB book mode a two-phase rotation turn: the surface rotated out,
the engine swapped the spread while it was edge-on, and the new spread rotated
back in. The keyframes hinged on `transform-origin: left center`
(`frontend/src/components/reader/epub/epubBookTurn.css`), so the spread swung
around the left edge of the view like a door.

UAT on 2026-10-27 found the motion wrong: a page turn pivots on the spine at
the center of the view, and a flipped half should land covering the other half.
The maintainer's verdict was to stop shipping the animation rather than ship a
turn that reads wrong, and to write down what a correct version needs.

A correct covering flip is not a CSS tweak. It needs four different page
pictures on screen at the same time:

1. the current right page, on the front of the turning half;
2. the incoming left page, on its back, mirrored so text reads correctly;
3. the current left page, underneath, until it is covered;
4. the incoming right page, revealed as the front lifts.

The live reading surface shows one spread at a time, so a second copy of the
spread has to come from somewhere. Where it comes from runs into three facts
about this reader:

- Sections render in same-origin sandboxed iframes and section markup stays
  inside frames (`frontend/src/lib/epub/contentPolicy.ts`,
  `sanitizeFrameDocument`, `docs/EPUB.md`). Cloning section markup into the
  parent document would weaken that fence.
- A screen capture of the reader surface is pixel-perfect, but the incoming
  spread has to be unoccluded for at least one frame to be captured it, while
  the current left page has to cover that same region from before the swap
  until the landing. Those two requirements contradict each other: every
  ordering shows either a brief flicker of the incoming spread or a capture
  that captured the overlay.
- A DOM clone of the section document avoids both, but the cloned left half
  must match the live right half exactly at the landing (fonts, images, column
  offsets) or a seam shows down the middle of the spread, and the clone must be
  torn down the moment the turn settles or text selection, highlights, and
  links stop working on the covered page.

## Decision

**D1. EPUB book mode lands spreads instantly in Stage 1.**
The turn goes through the existing adapter call surface with no animation, the
same behavior as the reduced-motion path. For EPUB, the spec's fallback rule
becomes the unconditional rule.

**D2. Remove the rotation machinery, do not leave it dormant.**
The phase state, timers, `EPUB_TURN_PHASE_MS`, `EpubTurnPhase`, the host's
`setPhase`, the keyframes, the `epub-turn-surface` class, and the
`data-epub-turn-phase` / `data-epub-turn-direction` publication are gone. The
factory is now `createInstantEpubBookTurn`, shaped like
`createInstantPdfBookTurn`. Dead animation code would drift from the seam and
from whatever Stage 2 builds.

**D3. Everything else in EPUB book mode stands.**
Edge and corner zones with their hover affordance, keyboard spread stepping
through the adapter, the named `role="region"` surface, the implied
two-column paginated flow, and position restore are unchanged. The PDF side is
untouched.

**D4. Keep the reduced-motion flag wired through the seam.**
The view still reads `usePrefersReducedMotion` and passes the flag into the
adapter, and the adapter still never reads the media query itself. Both paths
behave the same today; the flag is plumbing for Stage 2's renderer.

**D5. The animated EPUB turn reopens as `tuxbooks-2ir`.**
That ticket carries the visual target and the constraints above.

## Considered options

- **A. Screenshot capture through a new Electron IPC.** `webContents.capturePage`
  cropped in the renderer gives pixel-perfect halves and keeps markup inside
  frames. Cost: the exposure contradiction from Context, a new main/preload
  API, and a fallback to the instant path when a capture fails.
- **B. A second sandboxed iframe holding a clone of the section document.** No
  exposure window and no IPC, markup stays in frames. Cost: fidelity at the
  landing and teardown at settle, both in Context, plus building and sizing a
  second frame per turn.
- **C. One content instance, whole spread rotating about the center axis with
  the content swapped while edge-on.** Needs no copies at all and hinges in the
  right place, but no half ever covers the other, so it does not meet the
  visual target.
- **D. Keep the animation as shipped.** Rejected by UAT: the hinge is in the
  wrong place and the motion would annoy readers.

## How to switch

Pick A or B, rebuild the animation behind `EpubBookTurnAdapter`
(`reducedMotion`, `advance()`, `retreat()` resolving the settled locator), and
keep the instant path as the reduced-motion and capture-failure fallback. The
zone, keyboard, and preference plumbing from D3 are the attachment points and
should not need to change. Follow `tuxbooks-2ir` for the acceptance criteria.

## Consequences

- PDF and EPUB book mode now behave the same: the spread changes instantly,
  and reduced motion runs the same code path as everything else.
- Stories 22 and 23 of the spec (EPUB turn animation, suppressed under reduced
  motion) are not delivered in Stage 1. The spec ticket and `tuxbooks-9pr.7`
  carry comments recording the supersession.
- Nothing in the app animates a page turn until Stage 2: `pagecurl-gl` for PDF,
  `tuxbooks-2ir` for EPUB.
- About 300 lines of phase, timer, and keyframe code left the tree.

## Evidence

- UAT finding, 2026-10-27: the removed `epubBookTurn.css` hinged every
  keyframe on `transform-origin: left center`, which is the door-swing motion
  the verdict rejected.
- Commit `84bf812` removes the machinery and renames the factory; merge
  `1f70d88` brings it to the integration branch. `just check` passed on that
  tree (format, lint, typecheck, rust and frontend tests, electron typecheck).
- `frontend/tests/epubBookTurn.test.ts`: adapter contract, 7 tests. One move
  per press in the right direction, the settled locator resolves back, a failed
  move resolves null, and a throwing `matchMedia` stub proves the adapter never
  reads the media query itself.
- `frontend/tests/EpubReader.test.tsx`: `turns the spread instantly on
  advance, with no animation observable` and `lands the same instant spread
  change under reduced motion`, both red before the change (8 failed) and
  green after; 37 tests pass across the two EPUB files.
- `e2e/specs/book-mode.e2e.ts`: the MutationObserver phase log became a
  `turnPhaseAttributes` counter that reads 0 right after a zone click and after
  the position moves, and the reduced-motion emulation case still runs.
- The constraint analysis in Context is recorded for Stage 2 in `tuxbooks-2ir`.
