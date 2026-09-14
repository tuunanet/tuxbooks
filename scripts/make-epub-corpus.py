#!/usr/bin/env python3
"""Deterministic EPUB corpus generator for the library-scale E2E (issue
#61, phase 3): N minimal-but-valid EPUB 3 books with varied titles and
authors. Stdlib only; runs in seconds so `just test-e2e` can generate the
corpus at setup time.

Byte-for-byte reproducibility is not guaranteed (zip stores wall-clock
mtimes) — only structure and naming are deterministic, which is all the
import pipeline and the scale spec rely on.

Usage: python3 scripts/make-epub-corpus.py <output-dir> [count]
"""

import sys
import zipfile
from pathlib import Path

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
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="nav"/>
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


def make_book(out_dir: Path, n: int, total: int) -> None:
    title = f"The {ADJECTIVES[n % len(ADJECTIVES)]} {NOUNS[(n * 7) % len(NOUNS)]} #{n:04d}"
    author = AUTHORS[n % len(AUTHORS)]
    uuid = f"00000000-0000-4000-8000-{n:012d}"
    path = out_dir / f"book-{n:04d}.epub"
    with zipfile.ZipFile(path, "w") as epub:
        epub.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        epub.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr(
            "OEBPS/content.opf",
            OPF.format(uuid=uuid, title=title, author=author, n=n, mm=f"{n % 60:02d}"),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        epub.writestr(
            "OEBPS/chapter1.xhtml",
            CHAPTER.format(title=title, author=author, n=n, total=total, filler=FILLER),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        epub.writestr("OEBPS/nav.xhtml", NAV, compress_type=zipfile.ZIP_DEFLATED)


def main() -> None:
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "qa-library")
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
    out_dir.mkdir(parents=True, exist_ok=True)
    for n in range(1, count + 1):
        make_book(out_dir, n, count)
    size = sum(p.stat().st_size for p in out_dir.glob("*.epub"))
    print(f"wrote {count} books to {out_dir} ({size / 1024:.0f} KiB total)")


if __name__ == "__main__":
    main()
