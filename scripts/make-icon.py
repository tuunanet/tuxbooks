#!/usr/bin/env python3
"""Generate scripts/icon-source.png (1024x1024) from the brand logo art.

Crops the rounded frame from brand/tuxbooks-dark.png and centers it on a
transparent square, the source layout Tauri's icon generator expects
(`pnpm tauri icon scripts/icon-source.png`). Deterministic output.

The frame bounds were measured on the 2026-09 pixel-art logo (light top/
left/bottom bevel, dark right bevel); if the art changes shape, re-measure
FRAME_BOX before trusting the crop.
"""
from pathlib import Path

from PIL import Image

SIZE = 1024
FRAME_BOX = (6, 9, 559, 631)  # left, top, right (exclusive), bottom (exclusive)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    art = Image.open(root / "brand" / "tuxbooks-dark.png").convert("RGBA")
    frame = art.crop(FRAME_BOX)

    side = max(frame.size)
    source = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    source.paste(frame, ((side - frame.width) // 2, (side - frame.height) // 2))
    source = source.resize((SIZE, SIZE), Image.LANCZOS)

    out = Path(__file__).resolve().parent / "icon-source.png"
    source.save(out, optimize=True)
    print(f"wrote {out} from {art.size} art, frame {frame.size}")


if __name__ == "__main__":
    main()
