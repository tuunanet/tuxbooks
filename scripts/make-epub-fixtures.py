#!/usr/bin/env python3
"""Generate the TuxBooks core EPUB fixture corpus (EPUB 2 + EPUB 3).

All fixture content is authored here as original, license-free text (same
philosophy as make-fixture.py for the PDF fixtures). One run writes three
layers that must stay in sync:

  tests/fixtures/epub/sources/    human-readable source trees (generated)
  tests/fixtures/epub/core/       the committed .epub artifacts (generated)
  tests/fixtures/epub/fixtures.toml  manifest: checksums, versions, sizes

Determinism contract — running this twice produces byte-identical output:
fixed ZIP metadata (timestamps, ordering, permissions, create_system),
"mimetype" first and STORED, everything else DEFLATED, fixed unique
identifiers, and content built from literals in this file (no clock, no
machine paths, no randomness).

--check regenerates everything into a temp dir, byte-compares it with the
committed tree, and validates manifest checksums, EPUB version identity,
malformed markers, and the size budget. It performs no network access; the
core corpus is fully self-contained by design (docs/testing.md).
"""

import argparse
import hashlib
import re
import sys
import tempfile
import tomllib
import zipfile
import zlib
import struct
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / "tests" / "fixtures" / "epub"

STAMP = (2024, 1, 1, 0, 0, 0)
MODIFIED = "2024-01-01T00:00:00Z"
MIMETYPE = "application/epub+zip"
AUTHOR = "Tuxbooks Fixtures"

# Size budget (bytes). The corpus runs far below these; the limits exist so
# an accidentally committed multi-megabyte book fails loudly instead of
# silently bloating every clone. Tightened from the defaults in the task
# plan because the actual corpus is tiny — raise them only deliberately.
CORE_FIXTURE_MAX = 100 * 1024  # 100 KB per generated EPUB
CORE_CORPUS_MAX = 512 * 1024  # 512 KB total committed corpus
SOURCE_FILE_MAX = 50 * 1024  # 50 KB per source-tree asset

LICENSE = "TuxBooks original fixture content; repository GPLv3 applies"


def uid(n: int) -> str:
    """Stable unique identifier for fixture number `n` (no random UUIDs)."""
    return f"urn:uuid:f0000000-0000-4000-8000-{n:012d}"


# --------------------------------------------------------------------------
# Shared XML templates
# --------------------------------------------------------------------------

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def opf2(uid_value: str, title: str, description: str, items, spine, cover_id=None) -> str:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<package xmlns="http://www.idpf.org/2007/opf"'
        ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
        ' xmlns:opf="http://www.idpf.org/2007/opf"'
        ' unique-identifier="pub-id" version="2.0">',
        "  <metadata>",
        f'    <dc:identifier id="pub-id">{uid_value}</dc:identifier>',
        f"    <dc:title>{title}</dc:title>",
        f'    <dc:creator opf:role="aut">{AUTHOR}</dc:creator>',
        "    <dc:language>en</dc:language>",
        "    <dc:publisher>Tuxbooks Press</dc:publisher>",
        f"    <dc:description>{description}</dc:description>",
    ]
    if cover_id:
        lines.append(f'    <meta name="cover" content="{cover_id}"/>')
    lines += ["  </metadata>", "  <manifest>"]
    lines.append('    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
    for item_id, href, media_type, props in items:
        prop_attr = f' properties="{props}"' if props else ""
        lines.append(f'    <item id="{item_id}" href="{href}" media-type="{media_type}"{prop_attr}/>')
    lines += ["  </manifest>", '  <spine toc="ncx">']
    for idref in spine:
        lines.append(f'    <itemref idref="{idref}"/>')
    lines += ["  </spine>", "</package>", ""]
    return "\n".join(lines)


def opf3(uid_value: str, title: str, description: str, items, spine, with_ncx=False) -> str:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<package xmlns="http://www.idpf.org/2007/opf"'
        ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
        ' unique-identifier="pub-id" version="3.0">',
        "  <metadata>",
        f'    <dc:identifier id="pub-id">{uid_value}</dc:identifier>',
        f"    <dc:title>{title}</dc:title>",
        f"    <dc:creator>{AUTHOR}</dc:creator>",
        "    <dc:language>en</dc:language>",
        "    <dc:publisher>Tuxbooks Press</dc:publisher>",
        f"    <dc:description>{description}</dc:description>",
        f'    <meta property="dcterms:modified">{MODIFIED}</meta>',
        "  </metadata>",
        "  <manifest>",
    ]
    if with_ncx:
        lines.append('    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
    for item_id, href, media_type, props in items:
        prop_attr = f' properties="{props}"' if props else ""
        lines.append(f'    <item id="{item_id}" href="{href}" media-type="{media_type}"{prop_attr}/>')
    spine_open = '  <spine toc="ncx">' if with_ncx else "  <spine>"
    lines += ["  </manifest>", spine_open]
    for idref in spine:
        lines.append(f'    <itemref idref="{idref}"/>')
    lines += ["  </spine>", "</package>", ""]
    return "\n".join(lines)


def ncx(uid_value: str, doc_title: str, points) -> str:
    """NCX nav map. `points` is a nested list: (id, label, src, children)."""
    counter = [0]

    def emit(point, indent):
        point_id, label, src, children = point
        counter[0] += 1
        order = counter[0]
        out = [
            f'{indent}<navPoint id="{point_id}" playOrder="{order}">',
            f"{indent}  <navLabel><text>{label}</text></navLabel>",
            f'{indent}  <content src="{src}"/>',
        ]
        for child in children:
            out += emit(child, indent + "  ")
        out.append(f"{indent}</navPoint>")
        return out

    depth = 0

    def measure(node):
        return 1 + max((measure(c) for c in node[3]), default=0)

    for point in points:
        depth = max(depth, measure(point))

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">',
        "  <head>",
        f'    <meta name="dtb:uid" content="{uid_value}"/>',
        f'    <meta name="dtb:depth" content="{depth}"/>',
        '    <meta name="dtb:totalPageCount" content="0"/>',
        '    <meta name="dtb:maxPageNumber" content="0"/>',
        "  </head>",
        "  <docTitle>",
        f"    <text>{doc_title}</text>",
        "  </docTitle>",
        "  <navMap>",
    ]
    for point in points:
        lines += emit(point, "    ")
    lines += ["  </navMap>", "</ncx>", ""]
    return "\n".join(lines)


def nav3(doc_title: str, toc_items, landmarks=None) -> str:
    """EPUB 3 nav document. `toc_items` nests via (label, src, children)."""

    def emit_toc(entry, indent):
        label, src, children = entry
        out = [f"{indent}<li><a href=\"{src}\">{label}</a>"]
        if children:
            out.append(f"{indent}  <ol>")
            for child in children:
                out += emit_toc(child, indent + "    ")
            out.append(f"{indent}  </ol>")
        out.append(f"{indent}</li>")
        return out

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
        "  <head>",
        f"    <title>{doc_title}</title>",
        "  </head>",
        "  <body>",
        '    <nav epub:type="toc" id="toc">',
        "      <h1>Contents</h1>",
        "      <ol>",
    ]
    for entry in toc_items:
        lines += emit_toc(entry, "        ")
    lines += ["      </ol>", "    </nav>"]
    if landmarks:
        lines += [
            '    <nav epub:type="landmarks" id="landmarks" hidden="">',
            "      <h2>Landmarks</h2>",
            "      <ol>",
        ]
        for epub_type, label, src in landmarks:
            lines.append(f'        <li><a epub:type="{epub_type}" href="{src}">{label}</a></li>')
        lines += ["      </ol>", "    </nav>"]
    lines += ["  </body>", "</html>", ""]
    return "\n".join(lines)


def xhtml2(title: str, body: str, with_css=False) -> str:
    head = f"    <title>{title}</title>"
    if with_css:
        head += '\n    <link rel="stylesheet" type="text/css" href="style.css"/>'
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN"'
        ' "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n'
        '<html xmlns="http://www.w3.org/1999/xhtml">\n'
        f"  <head>\n{head}\n  </head>\n  <body>\n{body}\n  </body>\n</html>\n"
    )


def xhtml3(title: str, body: str, with_css=False, epub_attrs="") -> str:
    head = f"    <title>{title}</title>"
    if with_css:
        head += '\n    <link rel="stylesheet" type="text/css" href="style.css"/>'
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!DOCTYPE html>\n"
        f'<html xmlns="http://www.w3.org/1999/xhtml"'
        ' xmlns:epub="http://www.idpf.org/2007/ops"'
        f"{epub_attrs}>\n"
        f"  <head>\n{head}\n  </head>\n  <body>\n{body}\n  </body>\n</html>\n"
    )


def tiny_png(red: int, green: int, blue: int) -> bytes:
    """64x64 solid-color PNG built without external dependencies."""
    width = height = 64
    raw = b""
    for _ in range(height):
        raw += b"\x00" + bytes((red, green, blue)) * width

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(
            ">I", zlib.crc32(tag + data) & 0xFFFFFFFF
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


PNG_BLUE = tiny_png(37, 99, 235)
PNG_GREEN = tiny_png(22, 163, 74)

SVG_DOT = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="28" fill="#16a34a"/>
</svg>
"""

CSS_EPUB2 = """body { font-family: serif; margin: 1em; }
h1 { font-size: 1.4em; color: #0f172a; }
h2 { font-size: 1.2em; }
p.indented { text-indent: 1.5em; }
.callout { border-left: 3px solid #64748b; padding-left: 0.5em; font-style: italic; }
"""

CSS_EPUB2_IMPORTED = """@import url("style.css");
blockquote { color: #475569; margin-left: 1em; }
"""

CSS_EPUB3 = """body { font-family: serif; margin: 1em; line-height: 1.5; }
h1 { font-size: 1.4em; }
h2 { font-size: 1.2em; }
p.note { color: #475569; font-size: 0.9em; }
p.lead { font-weight: bold; }
@media (prefers-color-scheme: dark) {
  body { background: #0f172a; color: #e2e8f0; }
}
"""


# --------------------------------------------------------------------------
# Fixture registry — every valid core fixture, both generations
# --------------------------------------------------------------------------


def chapter_paragraph(num: int, gen_label: str) -> str:
    return (
        f"    <h1>Chapter {num}</h1>\n"
        f"    <p>Chapter {num} of the {gen_label} fixture corpus. Original"
        " placeholder text for deterministic tests.</p>"
    )


def build_valid():
    """Return [(fixture_id, gen, title, description, entries)] where entries
    is the complete zip content [(zip_path, str | bytes)]."""

    fixtures = []

    # -- EPUB 2 ------------------------------------------------------------
    g = "2.0"

    fixtures.append(
        (
            "epub2-minimal",
            g,
            "EPUB 2 Minimal",
            "Smallest valid EPUB 2 publication: container, OPF, one XHTML chapter, NCX.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf2(
                        uid(1),
                        "EPUB 2 Minimal",
                        "Smallest valid EPUB 2 publication.",
                        [("chapter1", "chapter1.xhtml", "application/xhtml+xml", "")],
                        ["chapter1"],
                    ),
                ),
                (
                    "OEBPS/toc.ncx",
                    ncx(
                        uid(1),
                        "EPUB 2 Minimal",
                        [("np-1", "Chapter One", "chapter1.xhtml", [])],
                    ),
                ),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml2(
                        "Chapter One",
                        "    <h1>Chapter One</h1>\n"
                        "    <p>The smallest valid EPUB 2 publication: a container, a package"
                        " document, one XHTML 1.1 chapter, and an NCX table of contents.</p>",
                    ),
                ),
            ],
        )
    )

    fixtures.append(
        (
            "epub2-navigation",
            g,
            "EPUB 2 Navigation",
            "Nested NCX navMap hierarchy over a three-chapter spine.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf2(
                        uid(2),
                        "EPUB 2 Navigation",
                        "Nested NCX navigation hierarchy.",
                        [
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                            ("chapter2", "chapter2.xhtml", "application/xhtml+xml", ""),
                            ("chapter3", "chapter3.xhtml", "application/xhtml+xml", ""),
                        ],
                        ["chapter1", "chapter2", "chapter3"],
                    ),
                ),
                (
                    "OEBPS/toc.ncx",
                    ncx(
                        uid(2),
                        "EPUB 2 Navigation",
                        [
                            (
                                "part-1",
                                "Part One",
                                "chapter1.xhtml",
                                [
                                    ("ch-1", "Chapter One", "chapter1.xhtml", []),
                                    ("ch-2", "Chapter Two", "chapter2.xhtml", []),
                                ],
                            ),
                            (
                                "part-2",
                                "Part Two",
                                "chapter3.xhtml",
                                [("ch-3", "Chapter Three", "chapter3.xhtml", [])],
                            ),
                        ],
                    ),
                ),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml2("Chapter One", chapter_paragraph(1, "EPUB 2 navigation")),
                ),
                (
                    "OEBPS/chapter2.xhtml",
                    xhtml2("Chapter Two", chapter_paragraph(2, "EPUB 2 navigation")),
                ),
                (
                    "OEBPS/chapter3.xhtml",
                    xhtml2("Chapter Three", chapter_paragraph(3, "EPUB 2 navigation")),
                ),
            ],
        )
    )

    fixtures.append(
        (
            "epub2-content",
            g,
            "EPUB 2 Content",
            "XHTML 1.1 richness: headings, lists, table, blockquote, emphasis.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf2(
                        uid(3),
                        "EPUB 2 Content",
                        "Rich XHTML 1.1 content structures.",
                        [
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                            ("chapter2", "chapter2.xhtml", "application/xhtml+xml", ""),
                        ],
                        ["chapter1", "chapter2"],
                    ),
                ),
                (
                    "OEBPS/toc.ncx",
                    ncx(
                        uid(3),
                        "EPUB 2 Content",
                        [
                            ("np-1", "Structures", "chapter1.xhtml", []),
                            ("np-2", "A Table", "chapter2.xhtml", []),
                        ],
                    ),
                ),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml2(
                        "Structures",
                        "    <h1>Structures</h1>\n"
                        "    <p>Text with <em>emphasis</em> and <strong>strength</strong>,"
                        " plus a second <h2> level below.</p>\n"
                        "    <h2>A List</h2>\n"
                        "    <ul>\n      <li>Unordered item</li>\n      <li>Another item</li>\n"
                        "    </ul>\n"
                        "    <h2>An Ordered List</h2>\n"
                        "    <ol>\n      <li>First step</li>\n      <li>Second step</li>\n"
                        "    </ol>\n"
                        "    <blockquote>Quoted material keeps its own element.</blockquote>\n"
                        "    <hr/>\n"
                        "    <p>Content after a rule.</p>",
                    ),
                ),
                (
                    "OEBPS/chapter2.xhtml",
                    xhtml2(
                        "A Table",
                        "    <h1>A Table</h1>\n"
                        "    <table>\n"
                        "      <caption>Two rows</caption>\n"
                        "      <tr><th>Key</th><th>Value</th></tr>\n"
                        "      <tr><td>Format</td><td>EPUB 2</td></tr>\n"
                        "      <tr><td>Chapters</td><td>2</td></tr>\n"
                        "    </table>\n"
                        "    <p>A footnote marker<sup>1</sup> without the link machinery.</p>",
                    ),
                ),
            ],
        )
    )

    fixtures.append(
        (
            "epub2-styling",
            g,
            "EPUB 2 Styling",
            "Linked CSS, an @import chain, class selectors, and an inline style.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf2(
                        uid(4),
                        "EPUB 2 Styling",
                        "CSS styling mechanisms.",
                        [
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                            ("chapter2", "chapter2.xhtml", "application/xhtml+xml", ""),
                            ("css", "style.css", "text/css", ""),
                            ("css-imported", "fancy.css", "text/css", ""),
                        ],
                        ["chapter1", "chapter2"],
                    ),
                ),
                (
                    "OEBPS/toc.ncx",
                    ncx(
                        uid(4),
                        "EPUB 2 Styling",
                        [
                            ("np-1", "Styled Text", "chapter1.xhtml", []),
                            ("np-2", "More Style", "chapter2.xhtml", []),
                        ],
                    ),
                ),
                ("OEBPS/style.css", CSS_EPUB2),
                ("OEBPS/fancy.css", CSS_EPUB2_IMPORTED),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml2(
                        "Styled Text",
                        "    <h1>Styled Text</h1>\n"
                        '    <p class="indented">A paragraph using the indented class.</p>\n'
                        '    <div class="callout">A callout block styled through fancy.css'
                        " (imported by style.css).</div>\n"
                        '    <p style="text-align: center;">An inline style attribute.</p>',
                        with_css=True,
                    ),
                ),
                (
                    "OEBPS/chapter2.xhtml",
                    xhtml2(
                        "More Style",
                        "    <h1>More Style</h1>\n"
                        "    <blockquote>A blockquote colored by the imported stylesheet.</blockquote>\n"
                        "    <p>Regular body text inherits the serif stack.</p>",
                        with_css=True,
                    ),
                ),
            ],
        )
    )

    fixtures.append(
        (
            "epub2-links",
            g,
            "EPUB 2 Links",
            "Cross-chapter links and same-document anchors in both directions.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf2(
                        uid(5),
                        "EPUB 2 Links",
                        "Internal link machinery.",
                        [
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                            ("chapter2", "chapter2.xhtml", "application/xhtml+xml", ""),
                        ],
                        ["chapter1", "chapter2"],
                    ),
                ),
                (
                    "OEBPS/toc.ncx",
                    ncx(
                        uid(5),
                        "EPUB 2 Links",
                        [
                            ("np-1", "References", "chapter1.xhtml", []),
                            ("np-2", "Notes", "chapter2.xhtml", []),
                        ],
                    ),
                ),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml2(
                        "References",
                        "    <h1>References</h1>\n"
                        '    <p>This sentence carries a <a href="chapter2.xhtml#note-1">footnote'
                        " reference</a> into the next chapter.</p>\n"
                        '    <p id="ref-1">Chapter two links back to this paragraph by its'
                        " anchor.</p>",
                    ),
                ),
                (
                    "OEBPS/chapter2.xhtml",
                    xhtml2(
                        "Notes",
                        "    <h1>Notes</h1>\n"
                        '    <p id="note-1">Note one: internal links stay inside the'
                        " publication.</p>\n"
                        '    <p><a href="chapter1.xhtml#ref-1">Return to chapter one</a>.</p>',
                    ),
                ),
            ],
        )
    )

    fixtures.append(
        (
            "epub2-images",
            g,
            "EPUB 2 Images",
            "Tiny PNGs referenced inline plus the legacy cover meta mechanism.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf2(
                        uid(6),
                        "EPUB 2 Images",
                        "Raster images and the EPUB 2 cover convention.",
                        [
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                            ("img-blue", "images/blue.png", "image/png", ""),
                            ("img-green", "images/green.png", "image/png", ""),
                        ],
                        ["chapter1"],
                        cover_id="img-blue",
                    ),
                ),
                (
                    "OEBPS/toc.ncx",
                    ncx(uid(6), "EPUB 2 Images", [("np-1", "Pictures", "chapter1.xhtml", [])]),
                ),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml2(
                        "Pictures",
                        "    <h1>Pictures</h1>\n"
                        '    <p><img src="images/blue.png" alt="Blue square"/></p>\n'
                        '    <p><img src="images/green.png" alt="Green square"/></p>\n'
                        "    <p>The blue PNG doubles as the book cover via the legacy"
                        " cover meta element.</p>",
                    ),
                ),
                ("OEBPS/images/blue.png", PNG_BLUE),
                ("OEBPS/images/green.png", PNG_GREEN),
            ],
        )
    )

    i18n_body = (
        "    <h1>Many Scripts</h1>\n"
        '    <p xml:lang="fr">Un paragraphe en fran\u00e7ais : caf\u00e9, cr\u00e8me'
        " br\u00fbl\u00e9e, d\u00e9j\u00e0 vu.</p>\n"
        '    <p xml:lang="de">Umlaute: Gr\u00fc\u00dfe aus K\u00f6ln, sch\u00f6n und'
        " gro\u00df.</p>\n"
        '    <p xml:lang="zh-Hans">\u7535\u5b50\u4e66\u9605\u8bfb\u5668\u6d4b\u8bd5'
        " \uff1a\u4e66\u7c4d\u662f\u4eba\u7c7b\u8fdb\u6b65\u7684\u9636\u68af\u3002</p>\n"
        '    <p dir="rtl" xml:lang="he">\u05e1\u05e4\u05e8\u05d9\u05dd \u05d4\u05dd'
        " \u05d7\u05dc\u05d5\u05e0\u05d5\u05ea \u05dc\u05e2\u05d5\u05dc\u05dd.</p>\n"
        "    <p>Right-to-left text above; this paragraph returns to left-to-right.</p>"
    )
    fixtures.append(
        (
            "epub2-i18n",
            g,
            "EPUB 2 i18n",
            "xml:lang on elements, RTL direction, CJK and accented scripts.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf2(
                        uid(7),
                        "EPUB 2 i18n",
                        "Basic internationalization.",
                        [("chapter1", "chapter1.xhtml", "application/xhtml+xml", "")],
                        ["chapter1"],
                    ),
                ),
                (
                    "OEBPS/toc.ncx",
                    ncx(uid(7), "EPUB 2 i18n", [("np-1", "Many Scripts", "chapter1.xhtml", [])]),
                ),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml2("Many Scripts", i18n_body),
                ),
            ],
        )
    )

    # -- EPUB 3 ------------------------------------------------------------

    g = "3.0"

    nav_items_flat = [("chapter1", "chapter1.xhtml", "application/xhtml+xml", "")]
    nav_entry = ("Chapter One", "chapter1.xhtml", [])

    fixtures.append(
        (
            "epub3-minimal",
            g,
            "EPUB 3 Minimal",
            "Smallest valid EPUB 3 publication: container, OPF, one XHTML chapter, nav.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf3(
                        uid(21),
                        "EPUB 3 Minimal",
                        "Smallest valid EPUB 3 publication.",
                        [
                            ("nav", "nav.xhtml", "application/xhtml+xml", "nav"),
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                        ],
                        ["chapter1"],
                    ),
                ),
                ("OEBPS/nav.xhtml", nav3("EPUB 3 Minimal", [nav_entry])),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml3(
                        "Chapter One",
                        "    <h1>Chapter One</h1>\n"
                        "    <p>The smallest valid EPUB 3 publication: a container, a package"
                        " document, one XHTML chapter, and a nav document. No NCX, no cover.</p>",
                    ),
                ),
            ],
        )
    )

    fixtures.append(
        (
            "epub3-navigation",
            g,
            "EPUB 3 Navigation",
            "Nested toc nav plus landmarks, with a flat NCX for EPUB 2 compatibility.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf3(
                        uid(22),
                        "EPUB 3 Navigation",
                        "Nav document navigation with an NCX fallback.",
                        [
                            ("nav", "nav.xhtml", "application/xhtml+xml", "nav"),
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                            ("chapter2", "chapter2.xhtml", "application/xhtml+xml", ""),
                            ("chapter3", "chapter3.xhtml", "application/xhtml+xml", ""),
                        ],
                        ["chapter1", "chapter2", "chapter3"],
                        with_ncx=True,
                    ),
                ),
                (
                    "OEBPS/nav.xhtml",
                    nav3(
                        "EPUB 3 Navigation",
                        [
                            (
                                "Part One",
                                "chapter1.xhtml",
                                [
                                    ("Chapter One", "chapter1.xhtml", []),
                                    ("Chapter Two", "chapter2.xhtml", []),
                                ],
                            ),
                            (
                                "Part Two",
                                "chapter3.xhtml",
                                [("Chapter Three", "chapter3.xhtml", [])],
                            ),
                        ],
                        landmarks=[
                            ("toc", "Table of Contents", "nav.xhtml"),
                            ("bodymatter", "Start of Content", "chapter1.xhtml"),
                        ],
                    ),
                ),
                (
                    "OEBPS/toc.ncx",
                    ncx(
                        uid(22),
                        "EPUB 3 Navigation",
                        [
                            ("np-1", "Chapter One", "chapter1.xhtml", []),
                            ("np-2", "Chapter Two", "chapter2.xhtml", []),
                            ("np-3", "Chapter Three", "chapter3.xhtml", []),
                        ],
                    ),
                ),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml3("Chapter One", chapter_paragraph(1, "EPUB 3 navigation")),
                ),
                (
                    "OEBPS/chapter2.xhtml",
                    xhtml3("Chapter Two", chapter_paragraph(2, "EPUB 3 navigation")),
                ),
                (
                    "OEBPS/chapter3.xhtml",
                    xhtml3("Chapter Three", chapter_paragraph(3, "EPUB 3 navigation")),
                ),
            ],
        )
    )

    fixtures.append(
        (
            "epub3-content",
            g,
            "EPUB 3 Content",
            "Semantic HTML5: section, article, figure, aside notes, time, inline SVG.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf3(
                        uid(23),
                        "EPUB 3 Content",
                        "Semantic HTML5 content structures.",
                        [
                            ("nav", "nav.xhtml", "application/xhtml+xml", "nav"),
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                            ("chapter2", "chapter2.xhtml", "application/xhtml+xml", ""),
                        ],
                        ["chapter1", "chapter2"],
                    ),
                ),
                (
                    "OEBPS/nav.xhtml",
                    nav3(
                        "EPUB 3 Content",
                        [
                            ("Semantic Structure", "chapter1.xhtml", []),
                            ("Lists and Notes", "chapter2.xhtml", []),
                        ],
                    ),
                ),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml3(
                        "Semantic Structure",
                        "    <section>\n"
                        "      <h1>Semantic Structure</h1>\n"
                        "      <article>\n"
                        "        <h2>An Article</h2>\n"
                        "        <p>This chapter exercises <code>section</code>,"
                        " <code>article</code>, <code>figure</code>, <code>aside</code>,"
                        " and <code>time</code>.</p>\n"
                        "        <figure>\n"
                        '          <svg xmlns="http://www.w3.org/2000/svg" width="64"'
                        ' height="64" viewBox="0 0 64 64">'
                        '<circle cx="32" cy="32" r="28" fill="#2563eb"/></svg>\n'
                        "          <figcaption>Figure 1: a tiny inline SVG.</figcaption>\n"
                        "        </figure>\n"
                        "      </article>\n"
                        '      <aside epub:type="note">A marginal note marked up as an'
                        " aside.</aside>\n"
                        '      <p>Written <time datetime="2024-01-01">New Year'
                        " 2024</time>.</p>\n"
                        "    </section>",
                    ),
                ),
                (
                    "OEBPS/chapter2.xhtml",
                    xhtml3(
                        "Lists and Notes",
                        "    <section>\n"
                        "      <h1>Lists and Notes</h1>\n"
                        "      <ol>\n        <li>First item</li>\n        <li>Second"
                        " item</li>\n      </ol>\n"
                        '      <p class="note">A paragraph styled by the shared stylesheet.</p>\n'
                        '      <aside epub:type="note">Chapter-level note.</aside>\n'
                        "    </section>",
                        with_css=True,
                    ),
                ),
                ("OEBPS/style.css", CSS_EPUB3),
            ],
        )
    )

    fixtures.append(
        (
            "epub3-styling",
            g,
            "EPUB 3 Styling",
            "Class selectors, a dark-mode media query, and shared stylesheets.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf3(
                        uid(24),
                        "EPUB 3 Styling",
                        "CSS styling mechanisms.",
                        [
                            ("nav", "nav.xhtml", "application/xhtml+xml", "nav"),
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                            ("chapter2", "chapter2.xhtml", "application/xhtml+xml", ""),
                            ("css", "style.css", "text/css", ""),
                        ],
                        ["chapter1", "chapter2"],
                    ),
                ),
                (
                    "OEBPS/nav.xhtml",
                    nav3(
                        "EPUB 3 Styling",
                        [("Styled Text", "chapter1.xhtml", []), ("More Style", "chapter2.xhtml", [])],
                    ),
                ),
                ("OEBPS/style.css", CSS_EPUB3),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml3(
                        "Styled Text",
                        "    <h1>Styled Text</h1>\n"
                        '    <p class="lead">A lead paragraph using the lead class.</p>\n'
                        '    <p class="note">A note paragraph colored by the stylesheet.</p>',
                        with_css=True,
                    ),
                ),
                (
                    "OEBPS/chapter2.xhtml",
                    xhtml3(
                        "More Style",
                        "    <h1>More Style</h1>\n"
                        "    <p>Body text inherits the shared line height and serif"
                        " stack.</p>\n"
                        "    <p>The stylesheet carries a prefers-color-scheme media query"
                        " for the dark theme.</p>",
                        with_css=True,
                    ),
                ),
            ],
        )
    )

    fixtures.append(
        (
            "epub3-links",
            g,
            "EPUB 3 Links",
            "epub:type noteref/footnote pairs plus cross-chapter anchors.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf3(
                        uid(25),
                        "EPUB 3 Links",
                        "Internal link machinery with epub:type semantics.",
                        [
                            ("nav", "nav.xhtml", "application/xhtml+xml", "nav"),
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                            ("chapter2", "chapter2.xhtml", "application/xhtml+xml", ""),
                        ],
                        ["chapter1", "chapter2"],
                    ),
                ),
                (
                    "OEBPS/nav.xhtml",
                    nav3(
                        "EPUB 3 Links",
                        [("References", "chapter1.xhtml", []), ("Notes", "chapter2.xhtml", [])],
                    ),
                ),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml3(
                        "References",
                        "    <h1>References</h1>\n"
                        '    <p>This sentence carries a <a epub:type="noteref"'
                        ' href="chapter2.xhtml#note-1"><sup>1</sup></a> into the next'
                        " chapter.</p>\n"
                        '    <p id="ref-1">Chapter two links back to this paragraph by'
                        " its anchor.</p>",
                    ),
                ),
                (
                    "OEBPS/chapter2.xhtml",
                    xhtml3(
                        "Notes",
                        "    <h1>Notes</h1>\n"
                        '    <aside epub:type="footnote" id="note-1">\n'
                        "      <p>Note one: internal links stay inside the publication.</p>\n"
                        "    </aside>\n"
                        '    <p><a href="chapter1.xhtml#ref-1">Return to chapter one</a>.</p>',
                    ),
                ),
            ],
        )
    )

    fixtures.append(
        (
            "epub3-images",
            g,
            "EPUB 3 Images",
            "cover-image property, inline SVG, a standalone SVG document, tiny PNGs.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf3(
                        uid(26),
                        "EPUB 3 Images",
                        "Raster and vector images plus the EPUB 3 cover property.",
                        [
                            ("nav", "nav.xhtml", "application/xhtml+xml", "nav"),
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                            (
                                "cover-image",
                                "images/blue.png",
                                "image/png",
                                "cover-image",
                            ),
                            ("img-svg", "images/dot.svg", "image/svg+xml", ""),
                        ],
                        ["chapter1"],
                    ),
                ),
                (
                    "OEBPS/nav.xhtml",
                    nav3("EPUB 3 Images", [("Pictures", "chapter1.xhtml", [])]),
                ),
                (
                    "OEBPS/chapter1.xhtml",
                    xhtml3(
                        "Pictures",
                        "    <h1>Pictures</h1>\n"
                        "    <p>Inline SVG follows:</p>\n"
                        '    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"'
                        ' viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"'
                        ' fill="#2563eb"/></svg>\n'
                        '    <p><img src="images/dot.svg" alt="Green dot"/></p>\n'
                        '    <p><img src="images/blue.png" alt="Blue square"/></p>\n'
                        "    <p>The blue PNG doubles as the book cover via the"
                        " cover-image property.</p>",
                    ),
                ),
                ("OEBPS/images/blue.png", PNG_BLUE),
                ("OEBPS/images/dot.svg", SVG_DOT),
            ],
        )
    )

    i18n3_body = (
        "    <h1>Many Scripts</h1>\n"
        '    <p xml:lang="fr">Un paragraphe en fran\u00e7ais : caf\u00e9, cr\u00e8me'
        " br\u00fbl\u00e9e, d\u00e9j\u00e0 vu.</p>\n"
        '    <p xml:lang="zh-Hans">\u7535\u5b50\u4e66\u9605\u8bfb\u5668\u6d4b\u8bd5'
        " \uff1a\u4e66\u7c4d\u662f\u4eba\u7c7b\u8fdb\u6b65\u7684\u9636\u68af\u3002</p>\n"
        '    <p xml:lang="ja"><ruby>\u6f22\u5b57<rt>\u304b\u3093\u3058</rt></ruby>'
        " \u306e\u30c6\u30b9\u30c8\u3002</p>\n"
        '    <p dir="rtl" xml:lang="he">\u05e1\u05e4\u05e8\u05d9\u05dd \u05d4\u05dd'
        " \u05d7\u05dc\u05d5\u05e0\u05d5\u05ea \u05dc\u05e2\u05d5\u05dc\u05dd.</p>\n"
        '    <p style="writing-mode: vertical-rl;">A vertically written'
        " paragraph.</p>\n"
        "    <p>Right-to-left and vertical text above; this paragraph returns to"
        " horizontal left-to-right.</p>"
    )
    fixtures.append(
        (
            "epub3-i18n",
            g,
            "EPUB 3 i18n",
            "xml:lang, RTL, CJK, ruby annotation, and vertical writing.",
            [
                ("mimetype", MIMETYPE),
                ("META-INF/container.xml", CONTAINER),
                (
                    "OEBPS/content.opf",
                    opf3(
                        uid(27),
                        "EPUB 3 i18n",
                        "Basic internationalization.",
                        [
                            ("nav", "nav.xhtml", "application/xhtml+xml", "nav"),
                            ("chapter1", "chapter1.xhtml", "application/xhtml+xml", ""),
                        ],
                        ["chapter1"],
                    ),
                ),
                (
                    "OEBPS/nav.xhtml",
                    nav3("EPUB 3 i18n", [("Many Scripts", "chapter1.xhtml", [])]),
                ),
                ("OEBPS/chapter1.xhtml", xhtml3("Many Scripts", i18n3_body)),
            ],
        )
    )

    return fixtures


# --------------------------------------------------------------------------
# Malformed fixtures — generated by mutating the minimal publication
# --------------------------------------------------------------------------


def _minimal_entries(gen_prefix: str):
    for fixture_id, gen, _title, _desc, entries in build_valid():
        if fixture_id == f"{gen_prefix}-minimal":
            return [(name, data) for name, data in entries]
    raise AssertionError("minimal fixture missing")


def _mut_no_mimetype(entries):
    return [(n, d) for n, d in entries if n != "mimetype"]


def _mut_wrong_mimetype(entries):
    return [(("mimetype", "application/zip") if n == "mimetype" else (n, d)) for n, d in entries]


def _mut_no_container(entries):
    return [(n, d) for n, d in entries if n != "META-INF/container.xml"]


def _mut_no_rootfile(entries):
    out = []
    for n, d in entries:
        if n == "META-INF/container.xml":
            d = d.replace(
                "    <rootfile full-path=\"OEBPS/content.opf\""
                ' media-type="application/oebps-package+xml"/>\n', ""
            )
        out.append((n, d))
    return out


def _mut_missing_opf(entries):
    out = []
    for n, d in entries:
        if n == "META-INF/container.xml":
            d = d.replace("OEBPS/content.opf", "OEBPS/gone.opf")
        out.append((n, d))
    return out


def _mut_no_title(entries):
    out = []
    for n, d in entries:
        if n == "OEBPS/content.opf":
            d = re.sub(r"[ \t]*<dc:title>[^<]*</dc:title>\n", "", d)
        out.append((n, d))
    return out


def _mut_broken_spine(entries):
    out = []
    for n, d in entries:
        if n == "OEBPS/content.opf":
            d = d.replace('idref="chapter1"', 'idref="ghost"')
        out.append((n, d))
    return out


def _mut_opf_broken_xml(entries):
    out = []
    for n, d in entries:
        if n == "OEBPS/content.opf":
            d = d.replace("</package>", "</pacakge>")
        out.append((n, d))
    return out


# id -> (gen prefix, mutation, expected parser failure)
MALFORMED = {
    "no-mimetype": (_mut_no_mimetype, "MissingMimetype: first zip entry is not mimetype"),
    "wrong-mimetype": (
        _mut_wrong_mimetype,
        "InvalidMimetype: mimetype content is application/zip",
    ),
    "no-container": (_mut_no_container, "MissingContainer: no META-INF/container.xml"),
    "no-rootfile": (_mut_no_rootfile, "NoRootfile: container.xml declares no rootfile"),
    "missing-opf": (
        _mut_missing_opf,
        "MissingOpf: container points at absent OEBPS/gone.opf",
    ),
    "no-title": (_mut_no_title, "MissingTitle: package document has no dc:title"),
    "broken-spine": (
        _mut_broken_spine,
        "BrokenSpine: spine idref ghost missing from manifest",
    ),
    "opf-broken-xml": (_mut_opf_broken_xml, "OpfXml: mismatched end tag in content.opf"),
}


def build_all():
    """Return a list of manifest dicts (sorted by output path)."""
    manifest = []
    for fixture_id, gen, title, description, entries in build_valid():
        gen_dir = "epub2" if gen == "2.0" else "epub3"
        manifest.append(
            {
                "id": fixture_id,
                "path": f"core/{gen_dir}/{fixture_id.removeprefix(f'{gen_dir}-')}.epub",
                "opf_version": gen,
                "kind": "valid",
                "title": title,
                "description": description,
                "license": LICENSE,
                "entries": entries,
            }
        )
    for name, (mutation, expected_failure) in MALFORMED.items():
        for gen_dir, prefix in (("epub2", "epub2"), ("epub3", "epub3")):
            manifest.append(
                {
                    "id": f"{prefix}-malformed-{name}",
                    "path": f"core/{gen_dir}/malformed/{name}.epub",
                    "opf_version": "2.0" if gen_dir == "epub2" else "3.0",
                    "kind": "malformed",
                    "description": f"Intentionally malformed: {expected_failure}",
                    "expected_failure": expected_failure,
                    "license": LICENSE,
                    "entries": mutation(_minimal_entries(prefix)),
                }
            )
    manifest.sort(key=lambda f: f["path"])
    return manifest


# --------------------------------------------------------------------------
# Deterministic ZIP assembly
# --------------------------------------------------------------------------


def write_epub(path: Path, entries) -> None:
    ordered = sorted(entries, key=lambda e: (e[0] != "mimetype", e[0]))
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in ordered:
            if isinstance(data, str):
                data = data.encode("utf-8")
            info = zipfile.ZipInfo(name, date_time=STAMP)
            info.create_system = 3
            info.external_attr = 0o644 << 16
            if name == "mimetype":
                info.compress_type = zipfile.ZIP_STORED
                zf.writestr(info, data)
            else:
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, data, compresslevel=9)


def write_sources(fixtures, root: Path) -> None:
    """Emit the human-readable source trees (mirror of the zip content)."""
    for fixture in fixtures:
        gen_dir = "epub2" if fixture["opf_version"] == "2.0" else "epub3"
        if fixture["kind"] != "valid":
            continue  # malformed fixtures are generated mutations, not sources
        name = fixture["path"].split("/")[-1].removesuffix(".epub")
        source_dir = root / "sources" / gen_dir / name
        source_dir.mkdir(parents=True, exist_ok=True)
        for zip_path, data in fixture["entries"]:
            target = source_dir / zip_path
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(data, str):
                target.write_text(data, encoding="utf-8", newline="")
            else:
                target.write_bytes(data)


# --------------------------------------------------------------------------
# Manifest (fixtures.toml)
# --------------------------------------------------------------------------


def emit_manifest(fixtures, stats) -> str:
    """Emit fixtures.toml. `stats` maps fixture path -> (size_bytes, sha256)."""
    lines = [
        "# EPUB fixture corpus manifest. GENERATED by scripts/make-epub-fixtures.py",
        "# (regenerate with `just make-epub-fixtures`) — hand edits are overwritten.",
        "# Core fixtures are TuxBooks-authored; extended/conformance datasets are",
        "# external and must carry real provenance before they are added.",
        "schema_version = 1",
        "",
        "[limits]",
        f"core_fixture_max_bytes = {CORE_FIXTURE_MAX}",
        f"core_corpus_max_bytes = {CORE_CORPUS_MAX}",
        f"source_file_max_bytes = {SOURCE_FILE_MAX}",
        "",
    ]
    for fixture in fixtures:
        size, sha256 = stats[fixture["path"]]
        lines += [
            "[[fixture]]",
            f'id = "{fixture["id"]}"',
            f'path = "{fixture["path"]}"',
            f'opf_version = "{fixture["opf_version"]}"',
            f'kind = "{fixture["kind"]}"',
        ]
        if fixture["kind"] == "valid":
            lines.append(f'title = "{fixture["title"]}"')
        lines.append(f'description = "{fixture["description"]}"')
        if fixture["kind"] == "malformed":
            lines.append(f'expected_failure = "{fixture["expected_failure"]}"')
        lines += [
            f'license = "{fixture["license"]}"',
            f"size_bytes = {size}",
            f'sha256 = "{sha256}"',
            "",
        ]
    lines += [
        "# Extended/conformance datasets are intentionally absent in this first",
        "# version: an entry requires verified provenance (source URL, exact",
        "# version, license, sha256 of the exact archive), never invented values.",
        "# See tests/fixtures/epub/extended/README.md for the template and the",
        "# rules a new entry must satisfy before `just fetch-epub-extended` will",
        "# fetch it.",
        "dataset = []",
    ]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Generation and validation
# --------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make(root: Path, with_sources: bool) -> list[dict]:
    """Generate the corpus under `root`: sources/ (optional), core/, fixtures.toml."""
    fixtures = build_all()
    if with_sources:
        write_sources(fixtures, root)
    stats = {}
    for fixture in fixtures:
        target = root / fixture["path"]
        write_epub(target, fixture["entries"])
        stats[fixture["path"]] = (target.stat().st_size, sha256_file(target))
    (root / "fixtures.toml").write_text(emit_manifest(fixtures, stats), encoding="utf-8")
    return fixtures


def check() -> int:
    failures = []

    # 1. Determinism + freshness: regenerate into a temp dir and byte-compare.
    #    Only generated layers take part (sources/, core/, fixtures.toml); the
    #    hand-authored tier READMEs are excluded.
    generated_layers = ("sources/", "core/", "fixtures.toml")
    with tempfile.TemporaryDirectory() as tmp:
        expected = Path(tmp) / "epub"
        expected.mkdir()
        make(expected, with_sources=True)
        committed = {
            p.relative_to(ROOT)
            for p in ROOT.rglob("*")
            if p.is_file() and str(p.relative_to(ROOT)).startswith(generated_layers)
        }
        generated = {
            p.relative_to(expected)
            for p in expected.rglob("*")
            if p.is_file() and str(p.relative_to(expected)).startswith(generated_layers)
        }
        for rel in sorted(committed - generated):
            failures.append(f"committed but not generated: {rel}")
        for rel in sorted(generated - committed):
            failures.append(f"generated but not committed: {rel}")
        for rel in sorted(committed & generated):
            if (ROOT / rel).read_bytes() != (expected / rel).read_bytes():
                failures.append(f"drift between committed and regenerated: {rel} (run `just make-epub-fixtures`)")

    manifest_path = ROOT / "fixtures.toml"
    if not manifest_path.exists():
        print(f"FAIL: {manifest_path} missing", file=sys.stderr)
        return 1
    manifest = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
    limits = manifest.get("limits", {})
    fixture_max = limits.get("core_fixture_max_bytes", CORE_FIXTURE_MAX)
    corpus_max = limits.get("core_corpus_max_bytes", CORE_CORPUS_MAX)
    source_max = limits.get("source_file_max_bytes", SOURCE_FILE_MAX)

    entries = {f["path"]: f for f in manifest.get("fixture", [])}
    if len(entries) != len(manifest.get("fixture", [])):
        failures.append("duplicate fixture paths in fixtures.toml")

    # 2. Every manifest entry: file exists, size + checksum match, license set.
    total = 0
    for rel, fixture in sorted(entries.items()):
        path = ROOT / rel
        if not path.exists():
            failures.append(f"missing fixture file: {rel}")
            continue
        size = path.stat().st_size
        if size != fixture.get("size_bytes"):
            failures.append(f"size drift for {rel}: manifest {fixture.get('size_bytes')} != actual {size}")
        digest = sha256_file(path)
        if digest != fixture.get("sha256"):
            failures.append(f"checksum drift for {rel} (run `just make-epub-fixtures`)")
        if not fixture.get("license"):
            failures.append(f"no license recorded for {rel}")
        if fixture["kind"] == "malformed" and not fixture.get("expected_failure"):
            failures.append(f"malformed fixture {rel} lacks expected_failure")
        if size > fixture_max:
            failures.append(
                f"Large fixture detected: {rel} is {size} bytes (limit {fixture_max})."
                " Move this test to the extended/conformance corpus rather than"
                " committing it to the core fixture set."
            )
        total += size
    if total > corpus_max:
        failures.append(
            f"Large fixture detected: core corpus totals {total} bytes (limit"
            f" {corpus_max}). Move large tests to the extended/conformance"
            " corpus rather than committing them to the core fixture set."
        )

    # 3. Size limits for source assets.
    for path in sorted((ROOT / "sources").rglob("*")):
        if path.is_file() and path.stat().st_size > source_max:
            failures.append(
                f"Large source asset detected: {path.relative_to(ROOT)} is"
                f" {path.stat().st_size} bytes (limit {source_max})."
            )

    # 4. Generation identity: EPUB 2 fixtures say 2.0, EPUB 3 say 3.0.
    for rel, fixture in sorted(entries.items()):
        if fixture["kind"] != "valid":
            continue
        try:
            with zipfile.ZipFile(ROOT / rel) as zf:
                opf = zf.read("OEBPS/content.opf").decode("utf-8")
        except (zipfile.BadZipFile, KeyError, UnicodeDecodeError, OSError) as err:
            failures.append(f"{rel}: unreadable as an EPUB ({err})")
            continue
        match = re.search(r'<package[^>]*version="([^"]+)"', opf)
        if not match or match.group(1) != fixture["opf_version"]:
            failures.append(
                f"{rel}: OPF version {match.group(1) if match else 'absent'}"
                f" does not identify as EPUB {fixture['opf_version']}"
            )

    # 5. Extended/conformance stay empty of committed blobs (README only).
    for tier in ("extended", "conformance"):
        tier_dir = ROOT / tier
        if not tier_dir.is_dir():
            failures.append(f"missing tier directory: {tier}/")
            continue
        for path in sorted(tier_dir.rglob("*")):
            if path.is_file() and path.suffix != ".md":
                failures.append(
                    f"committed file in {tier}/: {path.relative_to(ROOT)} —"
                    " external datasets belong in .build/fixtures/epub/, not Git"
                )

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        print(f"epub fixture check: {len(failures)} problem(s)", file=sys.stderr)
        return 1

    count = len(entries)
    print(
        f"epub fixture check: OK — {count} core fixtures, corpus {total} bytes"
        f" (limits: {fixture_max}/fixture, {corpus_max}/corpus), deterministic"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="validate the committed corpus instead of generating"
    )
    args = parser.parse_args()
    if args.check:
        return check()
    fixtures = make(ROOT, with_sources=True)
    total = sum((ROOT / f["path"]).stat().st_size for f in fixtures)
    valid = sum(1 for f in fixtures if f["kind"] == "valid")
    malformed = len(fixtures) - valid
    print(
        f"wrote {len(fixtures)} core EPUB fixtures ({valid} valid, {malformed}"
        f" malformed), corpus {total} bytes — sources/, core/, fixtures.toml"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
