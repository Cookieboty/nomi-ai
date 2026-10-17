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

    # Arm masks stop at the sleeve/hand silhouettes. The previous broad masks also
    # captured the long orange coat tails, which detached when a shoulder bone rotated.
    left_upper = mask_polygon(
        (width, height),
        [(432, 260), (300, 265), (225, 350), (210, 500), (245, 590),
         (365, 585), (420, 500), (445, 330)],
    )
    left_fore = mask_polygon(
        (width, height),
        [(350, 540), (245, 560), (215, 700), (250, 780), (320, 805),
         (350, 735), (360, 600)],
    )
    left_hand = mask_polygon(
        (width, height),
        [(320, 710), (250, 740), (250, 820), (290, 900), (325, 920),
         (340, 850), (335, 760)],
    )
    mirror = lambda points: [(width - x, y) for x, y in points]
    right_upper = mask_polygon((width, height), mirror([(432, 260), (300, 265), (225, 350), (210, 500), (245, 590), (365, 585), (420, 500), (445, 330)]))
    right_fore = mask_polygon((width, height), mirror([(365, 540), (245, 560), (215, 700), (250, 780), (330, 805), (390, 735), (405, 600)]))
    right_hand = mask_polygon((width, height), mirror([(330, 710), (250, 740), (250, 820), (290, 900), (345, 920), (380, 850), (370, 760)]))
    left_arm = ImageChops.lighter(ImageChops.lighter(left_upper, left_fore), left_hand)
    right_arm = ImageChops.lighter(ImageChops.lighter(right_upper, right_fore), right_hand)
    head = mask_polygon(
        (width, height),
        [
            (512, 0), (430, 0), (350, 42), (300, 112), (270, 200),
            (286, 278), (340, 320), (410, 334), (430, 358), (594, 358),
            (614, 334), (684, 320), (738, 278), (754, 200), (724, 112),
            (674, 42), (594, 0),
        ],
    )
    combined = ImageChops.lighter(ImageChops.lighter(left_arm, right_arm), head)
    # Keep the original alpha outside the arm masks and remove the arm pixels from the body.
    base = image.copy()
    alpha = base.getchannel("A")
    alpha = Image.composite(Image.new("L", (width, height), 0), alpha, combined)
    base.putalpha(alpha)
    base.save(out / "fullbody-base-no-head-arms.png")
    # Remove the superseded pre-head split so a rebuild cannot leave a stale layer
    # that looks like a production asset.
    old_base = out / "fullbody-base-no-arms.png"
    if old_base.exists():
        old_base.unlink()

    boxes = {
        "arm-l-upper": [180, 230, 450, 570],
        "arm-l-fore": [175, 470, 445, 790],
        "arm-l-hand": [200, 650, 430, 930],
        "arm-r-upper": [574, 230, width - 180, 570],
        "arm-r-fore": [579, 470, width - 175, 790],
        "arm-r-hand": [594, 650, width - 200, 930],
        "head": [250, 0, 780, 370],
    }
    masks = {
        "arm-l-upper": left_upper,
        "arm-l-fore": left_fore,
        "arm-l-hand": left_hand,
        "arm-r-upper": right_upper,
        "arm-r-fore": right_fore,
        "arm-r-hand": right_hand,
    }
    for name, box in boxes.items():
        crop = image.crop(tuple(box))
        if name in masks:
            crop.putalpha(ImageChops.multiply(crop.getchannel("A"), masks[name].crop(tuple(box))))
        crop.save(out / f"{name}.png")
    # The mother already contains a faithful neutral smile. This tiny transparent
    # overlay deepens the same mouth curve during the happy expression without
    # regenerating or repainting the character's face.
    S = 4
    smile = Image.new("RGBA", (120 * S, 70 * S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(smile)
    points = []
    for index in range(41):
        t = index / 40
        x = (42 + 54 * t) * S
        y = (34 + 13 * (1 - (2 * t - 1) ** 2)) * S
        points.append((round(x), round(y)))
    draw.line(points, fill=(104, 35, 32, 235), width=2 * S, joint="curve")
    draw.line([(56 * S, 47 * S), (82 * S, 47 * S)], fill=(245, 171, 157, 190), width=S)
    smile.resize((120, 70), Image.Resampling.LANCZOS).save(out / "face-smile.png")
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
