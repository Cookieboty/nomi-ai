#!/usr/bin/env python3
"""Remove the dark studio backdrop from relay full-body plates.

The relay plates are used only as pose art.  GrabCut is initialized from the
subject's central bounding box and the result is cleaned with a connected
component pass, preserving the generated pixels while making the backdrop
transparent for Rive image assets.
"""
from __future__ import annotations

from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from rembg import new_session, remove

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "generated"
OUT_DIR = ROOT / "rive/nomi-complete/fullbody"
PLATES = {
    "neutral": SRC_DIR / "rive-fullbody-neutral.png",
    "wave": SRC_DIR / "rive-fullbody-wave.png",
    "cheer": SRC_DIR / "rive-fullbody-cheer.png",
}


def extract(session, src: Path, dst: Path) -> None:
    with Image.open(src).convert('RGBA') as image:
        result = remove(image, session=session, alpha_matting=True, alpha_matting_foreground_threshold=240,
                        alpha_matting_background_threshold=8, alpha_matting_erode_size=3)
    alpha = np.array(result.getchannel('A'))
    ys, xs = np.where(alpha > 4)
    if xs.size == 0:
        raise SystemExit(f"empty extraction: {src}")
    pad = 8
    x0, x1 = max(0, xs.min() - pad), min(result.width, xs.max() + pad + 1)
    y0, y1 = max(0, ys.min() - pad), min(result.height, ys.max() + pad + 1)
    dst.parent.mkdir(parents=True, exist_ok=True)
    result.crop((x0, y0, x1, y1)).save(dst, optimize=True)
    print(f"wrote {dst} {x1 - x0}x{y1 - y0}")


def main() -> None:
    session = new_session('u2net_human_seg')
    for name, src in PLATES.items():
        extract(session, src, OUT_DIR / f"{name}.png")


if __name__ == "__main__":
    main()
