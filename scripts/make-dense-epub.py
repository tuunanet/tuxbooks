#!/usr/bin/env python3
"""Dense multi-chapter EPUB for the progress-bar seek-flash regression
(epub-reader-regressions.e2e.ts): twelve long chapters give the positions
list enough entries that a cross-section seek lands far from the section
anchor, exposing any relocate the engine lets through mid-jump. Stdlib
only; generated at setup so the phase stays self-contained.

Usage: python3 scripts/make-dense-epub.py <output-path>
"""

import sys
import zipfile
from pathlib import Path

CHAPTERS = 12
PARAGRAPHS = 60

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

CHAPTER = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head><title>Chapter {n}</title></head>
  <body>
    <h1>Chapter {n}</h1>
    {body}
  </body>
</html>
"""

PARA = (
    "The shelf exhaled a smell of paper and warm dust. Somewhere below, "
    "the reading room lamps hummed their long evening note, and the "
    "catalog kept its patient, alphabetical faith with every title "
    "entrusted to it. "
)


def main() -> None:
    out = Path(sys.argv[1])
    out.parent.mkdir(parents=True, exist_ok=True)

    manifest = "\n".join(
        f'    <item id="ch{n}" href="chapter{n}.xhtml" media-type="application/xhtml+xml"/>'
        for n in range(1, CHAPTERS + 1)
    )
    spine = "\n".join(f'    <itemref idref="ch{n}"/>' for n in range(1, CHAPTERS + 1))
    nav_li = "\n".join(
        f'        <li><a href="chapter{n}.xhtml">Chapter {n}</a></li>'
        for n in range(1, CHAPTERS + 1)
    )
    opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:11111111-1111-4111-8111-000000000001</dc:identifier>
    <dc:title>Reader Dense Sections</dc:title>
    <dc:creator>E. Probe</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
{manifest}
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
{spine}
  </spine>
</package>
"""
    nav = f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc"><ol>
{nav_li}
    </ol></nav>
  </body>
</html>
"""
    with zipfile.ZipFile(out, "w") as epub:
        epub.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        epub.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr("OEBPS/nav.xhtml", nav, compress_type=zipfile.ZIP_DEFLATED)
        for n in range(1, CHAPTERS + 1):
            body = "\n".join(f"    <p>{PARA}{n}.{k}</p>" for k in range(1, PARAGRAPHS + 1))
            epub.writestr(
                f"OEBPS/chapter{n}.xhtml",
                CHAPTER.format(n=n, body=body),
                compress_type=zipfile.ZIP_DEFLATED,
            )
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
