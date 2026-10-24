#!/usr/bin/env python3
"""Generate the mixed-size PDF fixture for the thumb-drag capture (issue
tuxbooks-x27.4).

The capture needs a document whose page measurements correct themselves
while a scrollbar drag is in flight. The reader estimates every unmeasured
page from a three-page opening sample (pages 1, 2, and the last page,
median by area — usePdfGeometry.ts), so the fixture is built to make that
estimate wrong for most of the document:

- pages 1-8   front matter, 500x650 — two of the three sample pages, so the
              median-by-area reference lands on the front-matter size;
- pages 9-392 body, cycling (612x792), (612x900), (612x720) — every body
              page is taller than its 650pt estimate, so measuring it
              rewrites the slot height and mutates scrollHeight;
- page 200    oversized, 700x1100 — wider than every sampled page, so when
              it is measured the fit-width scale reference grows, which is
              the path that can reach `reanchorByFraction` mid-drag.

Deterministic like scripts/make-fixture.py (no timestamps, fixed content),
so the committed PDF is byte-identical on every regeneration. Run:

    python3 scripts/make-thumb-capture-fixture.py

and commit the regenerated tests/fixtures/books/thumb-capture-mixed.pdf.
The capture procedure and its provenance live in
docs/research/pdf-viewer-perf-findings.md (Symptom 2).
"""

import hashlib
import importlib.util
import sys
from pathlib import Path

# Importing the shared writer must not drop a scripts/__pycache__/ into the
# tree (the fixture generator runs from a clean checkout).
sys.dont_write_bytecode = True

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "books" / "thumb-capture-mixed.pdf"

# Import the shared deterministic PDF writer from scripts/make-fixture.py
# (module name has a dash, so import by path).
_spec = importlib.util.spec_from_file_location(
    "make_fixture", REPO_ROOT / "scripts" / "make-fixture.py"
)
make_fixture = importlib.util.module_from_spec(_spec)
sys.modules["make_fixture"] = make_fixture
_spec.loader.exec_module(make_fixture)

TOTAL_PAGES = 392
FRONT_MATTER_PAGES = 8
FRONT_MATTER_SIZE = (500, 650)
BODY_SIZES = [(612, 792), (612, 900), (612, 720)]
OVERSIZED_PAGE = 200  # 1-based; wider than every sampled page
OVERSIZED_SIZE = (700, 1100)


def page_size(number: int) -> tuple[int, int]:
    """MediaBox size for a 1-based page number."""
    if number <= FRONT_MATTER_PAGES:
        return FRONT_MATTER_SIZE
    if number == OVERSIZED_PAGE:
        return OVERSIZED_SIZE
    return BODY_SIZES[(number - FRONT_MATTER_PAGES - 1) % len(BODY_SIZES)]


def main() -> None:
    pages = [
        {
            "mediabox": (0, 0, width, height),
            "label": f"Page {number} of {TOTAL_PAGES}",
        }
        for number in range(1, TOTAL_PAGES + 1)
        for (width, height) in [page_size(number)]
    ]
    make_fixture.write_pdf(
        FIXTURE,
        pages,
        "Thumb Capture Mixed",
        "Mixed-size fixture for the scrollbar thumb-drag capture "
        "(tuxbooks-x27.4): front matter, varied body heights, one oversized page.",
    )
    digest = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
    print(f"sha256 {digest}")
    print(f"pages {TOTAL_PAGES} (front matter {FRONT_MATTER_PAGES}x{FRONT_MATTER_SIZE}, "
          f"body cycling {BODY_SIZES}, page {OVERSIZED_PAGE} = {OVERSIZED_SIZE})")


if __name__ == "__main__":
    main()
