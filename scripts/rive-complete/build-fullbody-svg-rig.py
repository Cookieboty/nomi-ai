#!/usr/bin/env python3
"""Create the SVG-backed full-body rig source assets from the approved mother image.

The SVG intentionally embeds the mother PNG. This preserves the exact approved pixels
while giving the Rive project a portable SVG source asset. The RML rig uses matching
pixel crops for the arm bones so every crop stays in one source coordinate system.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "rive" / "nomi-complete"
SOURCE = PROJECT / "source-nomi-master.png"
OUT = PROJECT / "reference" / "svg-rig"


def write_svg(source: Path, destination: Path) -> None:
    encoded = base64.b64encode(source.read_bytes()).decode("ascii")
    with Image.open(source) as image:
        width, height = image.size
    destination.write_text(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        f"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" "
        f"width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\">\n"
        f"  <image width=\"{width}\" height=\"{height}\" preserveAspectRatio=\"none\" "
        f"href=\"data:image/png;base64,{encoded}\" xlink:href=\"data:image/png;base64,{encoded}\"/>\n"
        "</svg>\n",
        encoding="utf-8",
    )


def mask_polygon(size: tuple[int, int], points: list[tuple[int, int]]) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask


def make_layers(source: Path, out: Path) -> dict[str, list[int]]:
    image = Image.open(source).convert("RGBA")
    width, height = image.size

    # The polygons cover only the arm and jacket silhouettes. They intentionally overlap
    # at the joints so no transparent seam appears when a bone rotates.
    left_arm = mask_polygon(
        (width, height),
        [(430, 260), (300, 265), (220, 360), (195, 535), (215, 710),
         (220, 870), (420, 900), (440, 700), (445, 470)],
    )
    right_arm = mask_polygon(
        (width, height),
        [(594, 260), (724, 265), (804, 360), (829, 535), (809, 710),
         (804, 870), (604, 900), (584, 700), (579, 470)],
    )
    combined = ImageChops.lighter(left_arm, right_arm)
    # Keep the original alpha outside the arm masks and remove the arm pixels from the body.
    base = image.copy()
    alpha = base.getchannel("A")
    alpha = Image.composite(Image.new("L", (width, height), 0), alpha, combined)
    base.putalpha(alpha)
    base.save(out / "fullbody-base-no-arms.png")

    boxes = {
        "arm-l-upper": [180, 230, 450, 570],
        "arm-l-fore": [175, 470, 445, 790],
        "arm-l-hand": [200, 650, 430, 930],
        "arm-r-upper": [574, 230, width - 180, 570],
        "arm-r-fore": [579, 470, width - 175, 790],
        "arm-r-hand": [594, 650, width - 200, 930],
    }
    for name, box in boxes.items():
        image.crop(tuple(box)).save(out / f"{name}.png")
    return boxes


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with Image.open(SOURCE) as image:
        size = image.size
    artboard_scale = min(960 / size[0], 1300 / size[1])
    artboard_offset = [(960 - size[0] * artboard_scale) / 2, (1300 - size[1] * artboard_scale) / 2]
    write_svg(SOURCE, OUT / "nomi-fullbody-mother.svg")
    boxes = make_layers(SOURCE, OUT)
    (OUT / "rig-meta.json").write_text(
        json.dumps(
            {
                "source": str(SOURCE.relative_to(ROOT)).replace("\\", "/"),
                "size": list(size),
                "svg": "nomi-fullbody-mother.svg",
                "boxes": boxes,
                "artboardScale": artboard_scale,
                "artboardOffset": artboard_offset,
                "bones": [
                    "full.root",
                    "full.torso",
                    "full.head",
                    "full.arm-l.upper",
                    "full.arm-l.fore",
                    "full.arm-l.hand",
                    "full.arm-r.upper",
                    "full.arm-r.fore",
                    "full.arm-r.hand",
                ],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
