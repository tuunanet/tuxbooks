#!/usr/bin/env python3
"""Deterministic EPUB corpus generator for the library-scale E2E (issue
#61, phase 3): N minimal-but-valid EPUB 3 books with varied titles and
authors. Stdlib only; runs in seconds so `just test-e2e` can generate the
corpus at setup time.

Byte-for-byte reproducibility is not guaranteed (zip stores wall-clock
mtimes) — only structure and naming are deterministic, which is all the
import pipeline and the scale spec rely on.

Usage: python3 scripts/make-epub-corpus.py [--cover] <output-dir> [count]

The --cover option embeds the committed library-benchmark cover image and
adds a cover page to each generated book.
"""

import argparse
import zipfile
from pathlib import Path
from typing import Optional

COVER_IMAGE = (
    Path(__file__).resolve().parents[1]
    / "tests"
    / "fixtures"
    / "epub"
    / "covers"
    / "library-bench-cover.png"
)

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:{uuid}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>en</dc:language>
    <dc:description>QA corpus book {n}: {title} by {author}.</dc:description>
    <meta property="dcterms:modified">2026-01-01T00:00:{mm}:00Z</meta>
  </metadata>
  <manifest>
{cover_manifest}    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
{cover_spine}    <itemref idref="nav"/>
    <itemref idref="ch1"/>
  </spine>
</package>
"""

CHAPTER = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head><title>{title}</title></head>
  <body>
    <h1>{title}</h1>
    <p>By {author}. QA corpus volume {n} of {total}.</p>
    <p>{filler}</p>
  </body>
</html>
"""

NAV = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Chapter 1</a></li></ol></nav>
  </body>
</html>
"""

COVER_MANIFEST = """    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
"""

COVER_SPINE = """    <itemref idref="cover-page"/>
"""

COVER_XHTML = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head><title>{title}</title></head>
  <body>
    <img src="cover.png" alt="{title}"/>
  </body>
</html>
"""

ADJECTIVES = [
    "Silent", "Golden", "Broken", "Distant", "Hidden", "Burning", "Frozen",
    "Wandering", "Forgotten", "Electric", "Crimson", "Hollow", "Endless",
    "Drowned", "Radiant", "Sharpened", "Weeping", "Gilded",
]
NOUNS = [
    "Harbor", "Garden", "Engine", "Winter", "Signal", "Empire", "Cathedral",
    "Machine", "Orchard", "Mirror", "Archipelago", "Foundry", "Meridian",
    "Almanac", "Lantern", "Frontier", "Cartography", "Symposium",
]
AUTHORS = [
    "A. Marlowe", "B. Kestrel", "C. Vane", "D. Whitlock", "E. Ferrante",
    "F. Okafor", "G. Lindqvist", "H. Amari", "I. Petrov", "J. Castellan",
]
FILLER = (
    "The shelf exhaled a smell of paper and warm dust. Somewhere below, "
    "the reading room lamps hummed their long evening note, and the "
    "catalog kept its patient, alphabetical faith with every title "
    "entrusted to it. "
) * 6


def make_book(out_dir: Path, n: int, total: int, cover_png: Optional[bytes] = None) -> None:
    title = f"The {ADJECTIVES[n % len(ADJECTIVES)]} {NOUNS[(n * 7) % len(NOUNS)]} #{n:04d}"
    author = AUTHORS[n % len(AUTHORS)]
    uuid = f"00000000-0000-4000-8000-{n:012d}"
    path = out_dir / f"book-{n:04d}.epub"
    cover_manifest = COVER_MANIFEST if cover_png is not None else ""
    cover_spine = COVER_SPINE if cover_png is not None else ""
    with zipfile.ZipFile(path, "w") as epub:
        epub.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        epub.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr(
            "OEBPS/content.opf",
            OPF.format(
                uuid=uuid,
                title=title,
                author=author,
                n=n,
                mm=f"{n % 60:02d}",
                cover_manifest=cover_manifest,
                cover_spine=cover_spine,
            ),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        epub.writestr(
            "OEBPS/chapter1.xhtml",
            CHAPTER.format(title=title, author=author, n=n, total=total, filler=FILLER),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        epub.writestr("OEBPS/nav.xhtml", NAV, compress_type=zipfile.ZIP_DEFLATED)
        if cover_png is not None:
            epub.writestr("OEBPS/cover.png", cover_png, compress_type=zipfile.ZIP_STORED)
            epub.writestr(
                "OEBPS/cover.xhtml",
                COVER_XHTML.format(title=title),
                compress_type=zipfile.ZIP_DEFLATED,
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_dir", nargs="?", default="qa-library")
    parser.add_argument("count", nargs="?", type=int, default=1500)
    parser.add_argument(
        "--cover",
        action="store_true",
        help="embed the committed library-benchmark cover in every book",
    )
    args = parser.parse_args()
    cover_png = COVER_IMAGE.read_bytes() if args.cover else None
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for n in range(1, args.count + 1):
        make_book(out_dir, n, args.count, cover_png)
    size = sum(p.stat().st_size for p in out_dir.glob("*.epub"))
    suffix = " with cover" if cover_png is not None else ""
    print(f"wrote {args.count} books{suffix} to {out_dir} ({size / 1024:.0f} KiB total)")


if __name__ == "__main__":
    main()
