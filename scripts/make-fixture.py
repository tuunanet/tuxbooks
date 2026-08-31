#!/usr/bin/env python3
"""Generate tests/fixtures/books/minimal.epub and minimal.pdf — tiny valid
book fixtures.

Deterministic: fixed timestamps and ordering, safe to commit to Git.
The book content is original placeholder text (no copyrighted material).
"""

import zipfile
import zlib
import struct
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "books"
EPUB_FIXTURE = FIXTURES / "minimal.epub"
PDF_FIXTURE = FIXTURES / "minimal.pdf"

MIMETYPE = "application/epub+zip"

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:6e8bc430-9c3a-11ef-8f2c-000000000001</dc:identifier>
    <dc:title>A Minimal Book</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>Tuxbooks Press</dc:publisher>
    <dc:identifier opf:scheme="ISBN">978-3-16-148410-0</dc:identifier>
    <dc:description>A tiny EPUB used as a test fixture.</dc:description>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>
"""

NAV = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="chapter1.xhtml">Chapter One</a></li>
      <li><a href="chapter2.xhtml">Chapter Two</a></li>
    </ol>
  </nav>
</body>
</html>
"""

def chapter(num: int, title: str, paragraphs: list[str]) -> str:
    body = "\n".join(f"    <p>{p}</p>" for p in paragraphs)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>{title}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
  <h1>{title}</h1>
{body}
</body>
</html>
"""

CHAPTER1 = chapter(1, "Chapter One", [
    "This is the first chapter of a minimal EPUB used for automated tests.",
    "It exists so that parsers, scanners, and the reader have something deterministic to open.",
])

CHAPTER2 = chapter(2, "Chapter Two", [
    "The second chapter completes the reading order.",
    "Two chapters are enough to verify that the spine is preserved.",
])

CSS = """body { font-family: serif; margin: 1em; }
h1 { font-size: 1.4em; }
"""

def tiny_png() -> bytes:
    """64x64 solid sky-blue PNG built without external dependencies."""
    width = height = 64
    raw = b""
    for _ in range(height):
        raw += b"\x00" + bytes((125, 211, 252)) * width

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )

def build_pdf() -> bytes:
    """Minimal but structurally valid PDF: catalog, one page, and an Info
    dictionary with the metadata the library indexes. Byte-identical on
    every run (no timestamps), so the imported book id stays stable."""

    def info_entry(key: str, value: str) -> str:
        escaped = value.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        return f"/{key} ({escaped})"

    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
        " ".join(
            [
                "<<",
                info_entry("Title", "A Minimal Manual"),
                info_entry("Author", "Grace Hopper"),
                info_entry("Subject", "A tiny PDF used as a test fixture."),
                ">>",
            ]
        ),
    ]

    pdf = "%PDF-1.4\n"
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += f"{index} 0 obj\n{body}\nendobj\n"

    xref_offset = len(pdf)
    pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    for offset in offsets:
        pdf += f"{offset:010} 00000 n \n"
    pdf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 4 0 R >>\n"
    pdf += f"startxref\n{xref_offset}\n%%EOF\n"
    return pdf.encode("ascii")


def write_epub() -> None:
    stamp = (2024, 1, 1, 0, 0, 0)

    with zipfile.ZipFile(EPUB_FIXTURE, "w") as zf:
        info = zipfile.ZipInfo("mimetype", date_time=stamp)
        info.compress_type = zipfile.ZIP_STORED
        zf.writestr(info, MIMETYPE)

        for name, text in [
            ("META-INF/container.xml", CONTAINER),
            ("OEBPS/content.opf", OPF),
            ("OEBPS/nav.xhtml", NAV),
            ("OEBPS/chapter1.xhtml", CHAPTER1),
            ("OEBPS/chapter2.xhtml", CHAPTER2),
            ("OEBPS/style.css", CSS),
        ]:
            info = zipfile.ZipInfo(name, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, text)

        info = zipfile.ZipInfo("OEBPS/cover.png", date_time=stamp)
        info.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(info, tiny_png())

    print(f"wrote {EPUB_FIXTURE} ({EPUB_FIXTURE.stat().st_size} bytes)")


def write_pdf() -> None:
    PDF_FIXTURE.write_bytes(build_pdf())
    print(f"wrote {PDF_FIXTURE} ({PDF_FIXTURE.stat().st_size} bytes)")


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    write_epub()
    write_pdf()

if __name__ == "__main__":
    main()
