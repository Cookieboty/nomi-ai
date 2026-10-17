#!/usr/bin/env python3
"""Create a transparent full-body plate from the supplied character sheet crop.

This is a deterministic background extraction, not a redraw: RGB pixels inside
the character silhouette are preserved and only the light sheet background is
made transparent.  The source crop is kept in rive/nomi-sheet/crops/.
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'rive/nomi-sheet/crops/layer-front-full@4x.jpg'
OUT = ROOT / 'rive/nomi-complete/official/layers/body-full.png'


def close_to_sheet(rgb: tuple[int, int, int]) -> bool:
    # The supplied crop uses a warm near-white sheet. Keep saturated orange,
    # skin, hair and cloth while accepting small JPEG variations in the paper.
    r, g, b = rgb
    return min(r, g, b) >= 214 and max(r, g, b) - min(r, g, b) <= 28


def main() -> None:
    image = Image.open(SRC).convert('RGBA')
    px = image.load(); width, height = image.size
    seen = bytearray(width * height)
    q: deque[tuple[int, int]] = deque()

    def push(x: int, y: int) -> None:
        i = y * width + x
        if seen[i]: return
        seen[i] = 1; q.append((x, y))

    for x in range(width):
        push(x, 0); push(x, height - 1)
    for y in range(height):
        push(0, y); push(width - 1, y)

    while q:
        x, y = q.popleft()
        if close_to_sheet(px[x, y][:3]):
            px[x, y] = (0, 0, 0, 0)
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < width and 0 <= ny < height:
                    push(nx, ny)

    # Remove sheet labels and neighbouring character fragments. The supplied
    # front figure is the largest connected component after extraction.
    array = np.array(image)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        (array[:, :, 3] > 0).astype(np.uint8), 8
    )
    if count <= 1:
        raise SystemExit('full-body extraction produced no opaque component')
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    array[labels != largest, 3] = 0
    image = Image.fromarray(array, 'RGBA')
    bbox = image.getchannel('A').getbbox()
    if bbox is None:
        raise SystemExit('full-body extraction produced an empty alpha mask')
    image = image.crop(bbox)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, optimize=True)
    print(f'wrote {OUT} {image.size[0]}x{image.size[1]}')


if __name__ == '__main__':
    main()
