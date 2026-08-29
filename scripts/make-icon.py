#!/usr/bin/env python3
"""Generate scripts/icon-source.png (1024x1024) without external deps.

Draws a simple book glyph on a dark rounded square. Deterministic output.
"""
import struct
import zlib
from pathlib import Path

SIZE = 1024

# Palette
BG = (24, 24, 27)        # zinc-900
PANEL = (63, 63, 70)     # zinc-500
ACCENT = (56, 189, 248)  # sky-400


def rounded_rect_mask(x: int, y: int, radius: int) -> bool:
    """Is (x, y) inside a rounded rect of size SIZE with corner radius?"""
    def corner(dx: int, dy: int) -> bool:
        return dx * dx + dy * dy <= radius * radius

    r = radius
    if x < r and y < r:
        return corner(r - x, r - y)
    if x >= SIZE - r and y < r:
        return corner(x - (SIZE - 1 - r), r - y)
    if x < r and y >= SIZE - r:
        return corner(r - x, y - (SIZE - 1 - r))
    if x >= SIZE - r and y >= SIZE - r:
        return corner(x - (SIZE - 1 - r), y - (SIZE - 1 - r))
    return True


def pixel(x: int, y: int) -> tuple[int, int, int]:
    if not rounded_rect_mask(x, y, 180):
        return (0, 0, 0)  # transparent

    # Open book: two page panels meeting at a center spine.
    cx = SIZE // 2
    top = 260
    bottom = 764
    spread = 300  # horizontal half-width of each panel

    if top <= y <= bottom:
        t = (y - top) / (bottom - top)  # 0..1 down the page
        # Panel edge curves outward slightly toward the bottom
        half = int(spread * (0.85 + 0.15 * t))
        dist = abs(x - cx)
        if 0 <= dist <= 8:
            return ACCENT  # spine
        if 8 < dist <= half:
            # Text lines: 7 light-gray bands on white pages
            line_no = int(t * 14)
            if line_no % 2 == 1 and 24 < dist < half - 48 and top + 40 < y < bottom - 40:
                return (161, 161, 170)  # zinc-400
            return (250, 250, 252)
    return BG


def main() -> None:
    rows = []
    for y in range(SIZE):
        row = bytearray(b"\x00")
        for x in range(SIZE):
            r, g, b = pixel(x, y)
            row += bytes((r, g, b, 255))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    out = Path(__file__).resolve().parent / "icon-source.png"
    out.write_bytes(png)
    print(f"wrote {out} ({len(png)} bytes)")


if __name__ == "__main__":
    main()
