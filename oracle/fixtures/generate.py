#!/usr/bin/env python3
"""Generate the fidelity-oracle fixture corpus.

Writes the PDF fixtures, a C header the harness compiles against, and a
human-readable manifest, all from one source of truth so the page geometry in
the harness cannot drift from the PDFs.

Pure standard library. The PDF writer is deliberately small: the oracle only
needs page count and page sizes, and the content streams exist so each fixture
is a real document of the named kind (scan, vector-heavy, and so on).

Run:  python3 oracle/fixtures/generate.py
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import zlib

HERE = pathlib.Path(__file__).resolve().parent
LETTER = (612.0, 792.0)
LEGAL = (612.0, 1008.0)
A4 = (595.276, 841.89)
A5 = (419.528, 595.276)


class Pdf:
    """Minimal PDF 1.4 writer with a correct xref table."""

    def __init__(self) -> None:
        self.objects: list[bytes | None] = [None]

    def alloc(self, data: bytes = b"") -> int:
        self.objects.append(data)
        return len(self.objects) - 1

    def set(self, num: int, data: bytes) -> None:
        self.objects[num] = data

    def write(self, path: pathlib.Path) -> None:
        out = bytearray()
        out += b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
        n = len(self.objects)
        offsets = [0] * n
        for i in range(1, n):
            offsets[i] = len(out)
            out += f"{i} 0 obj\n".encode("latin-1")
            out += self.objects[i] or b""
            out += b"\nendobj\n"
        xref = len(out)
        out += f"xref\n0 {n}\n".encode("latin-1")
        out += b"0000000000 65535 f \n"
        for i in range(1, n):
            out += f"{offsets[i]:010d} 00000 n \n".encode("latin-1")
        out += b"trailer\n"
        out += f"<< /Size {n} /Root 1 0 R >>\n".encode("latin-1")
        out += b"startxref\n"
        out += f"{xref}\n".encode("latin-1")
        out += b"%%EOF\n"
        path.write_bytes(out)


def num(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")


def stream_object(data: bytes, extra: str = "") -> bytes:
    header = f"<< /Length {len(data)}{extra} >>\nstream\n".encode("latin-1")
    return header + data + b"\nendstream"


class Lcg:
    """Small deterministic PRNG, independent of the Python version."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF

    def next_byte(self) -> int:
        self.state = (1103515245 * self.state + 12345) & 0x7FFFFFFF
        return (self.state >> 16) & 0xFF


def text_content(page_index: int) -> str:
    return (
        "BT /F1 24 Tf 72 700 Td (TuxBooks fidelity oracle) Tj ET\n"
        f"BT /F1 12 Tf 72 660 Td (page {page_index + 1}) Tj ET\n"
        "0.1 0.2 0.8 RG 2 w 72 120 m 540 120 l S\n"
        "0.1 0.2 0.8 rg 72 160 468 40 re f\n"
    )


def vector_content(seed: int, count: int) -> str:
    rng = Lcg(seed)
    parts = ["0.2 0.2 0.2 RG 0.75 w\n"]
    for i in range(count):
        x0 = 40 + rng.next_byte() * 2
        y0 = 40 + rng.next_byte() * 2
        x1 = 40 + rng.next_byte() * 2
        y1 = 40 + rng.next_byte() * 2
        gray = rng.next_byte() / 255.0
        parts.append(f"{gray:.3f} {gray:.3f} {gray:.3f} RG {x0} {y0} m {x1} {y1} l S\n")
    return "".join(parts)


def image_object(width: int, height: int, seed: int) -> bytes:
    rng = Lcg(seed)
    raw = bytearray()
    for y in range(height):
        base = (y * 255) // height
        for x in range(width):
            noise = rng.next_byte() // 8
            raw.append(min(255, max(0, base + noise - 16)))
    packed = zlib.compress(bytes(raw), 6)
    return stream_object(
        packed,
        extra=(
            f" /Type /XObject /Subtype /Image /Width {width} /Height {height}"
            " /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode"
        ),
    )


def build_pdf(path: pathlib.Path, pages: list[tuple[float, float]], kind: str) -> None:
    pdf = Pdf()
    catalog = pdf.alloc()
    pages_obj = pdf.alloc()
    font = pdf.alloc(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    image = None
    if kind == "scan":
        image = pdf.alloc()

    kids: list[str] = []
    for index, (width, height) in enumerate(pages):
        page_num = pdf.alloc()
        if kind == "vector-heavy":
            content = vector_content(seed=0xC0FFEE + index, count=600)
        elif kind == "scan":
            content = f"q {num(width)} 0 0 {num(height)} 0 0 cm /Im0 Do Q\n"
        else:
            content = text_content(index)
        content_num = pdf.alloc(stream_object(content.encode("latin-1")))

        resources = f"<< /Font << /F1 {font} 0 R >>"
        if image is not None:
            resources += f" /XObject << /Im0 {image} 0 R >>"
        resources += " >>"

        pdf.set(
            page_num,
            (
                f"<< /Type /Page /Parent {pages_obj} 0 R"
                f" /MediaBox [0 0 {num(width)} {num(height)}]"
                f" /Resources {resources} /Contents {content_num} 0 R >>"
            ).encode("latin-1"),
        )
        kids.append(f"{page_num} 0 R")

    pdf.set(catalog, f"<< /Type /Catalog /Pages {pages_obj} 0 R >>".encode("latin-1"))
    pdf.set(
        pages_obj,
        (
            f"<< /Type /Pages /Count {len(kids)} /Kids [{' '.join(kids)}] >>"
        ).encode("latin-1"),
    )
    if image is not None:
        pdf.set(image, image_object(600, 780, seed=0x5CA9))

    pdf.write(path)


def corpus() -> list[tuple[str, list[tuple[float, float]], str]]:
    return [
        ("single-page", [LETTER], "text"),
        ("mixed-sizes", [LETTER, A4, LEGAL, A5], "text"),
        ("portrait", [A4, A4, A4], "text"),
        ("landscape", [(A4[1], A4[0]), (A4[1], A4[0]), (LETTER[1], LETTER[0])], "text"),
        (
            "thousand-pages",
            [LETTER if i % 2 == 0 else A4 for i in range(1000)],
            "text",
        ),
        ("scan", [LETTER], "scan"),
        ("vector-heavy", [LETTER], "vector-heavy"),
    ]


def c_ident(name: str) -> str:
    return name.replace("-", "_")


def emit_header(path: pathlib.Path, fixtures: list[dict]) -> None:
    lines = [
        "/* Generated by oracle/fixtures/generate.py. Do not edit by hand. */",
        "#ifndef ORACLE_CORPUS_H",
        "#define ORACLE_CORPUS_H",
        "",
        "typedef struct {",
        "  double width;",
        "  double height;",
        "} OraclePageSize;",
        "",
        "typedef struct {",
        "  const char *name;",
        "  const char *pdf;",
        "  int page_count;",
        "  const OraclePageSize *pages;",
        "} OracleFixture;",
        "",
    ]
    for fixture in fixtures:
        ident = c_ident(fixture["name"])
        lines.append(f"static const OraclePageSize oracle_pages_{ident}[] = {{")
        for width, height in fixture["page_sizes"]:
            lines.append(f"  {{{num(width)}, {num(height)}}},")
        lines.append("};")
        lines.append("")
    lines.append("static const OracleFixture oracle_corpus[] = {")
    for fixture in fixtures:
        ident = c_ident(fixture["name"])
        lines.append(
            f'  {{"{fixture["name"]}", "{fixture["name"]}.pdf", '
            f'{fixture["page_count"]}, oracle_pages_{ident}}},'
        )
    lines.append("};")
    lines.append("")
    lines.append(f"#define ORACLE_CORPUS_COUNT {len(fixtures)}")
    lines.append("")
    lines.append("#endif /* ORACLE_CORPUS_H */")
    path.write_text("\n".join(lines) + "\n")


def main() -> None:
    fixtures = []
    for name, pages, kind in corpus():
        pdf_path = HERE / f"{name}.pdf"
        build_pdf(pdf_path, pages, kind)
        digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
        fixtures.append(
            {
                "name": name,
                "pdf": pdf_path.name,
                "kind": kind,
                "page_count": len(pages),
                "sha256": digest,
                "page_sizes": [[w, h] for w, h in pages],
            }
        )

    emit_header(HERE / "corpus.h", fixtures)
    (HERE / "manifest.json").write_text(json.dumps(fixtures, indent=2) + "\n")
    print(f"wrote {len(fixtures)} fixtures to {HERE}")


if __name__ == "__main__":
    main()
