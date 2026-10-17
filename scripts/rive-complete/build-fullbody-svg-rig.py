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
        # Keep a generous inner overlap at the elbow.  The sleeve edge reaches
        # into the torso around y=600; stopping at x=360 leaves a triangular
        # transparent bite in the neutral render.
        [(420, 535), (245, 560), (215, 700), (250, 780), (320, 805),
         (365, 760), (430, 690), (435, 600)],
    )
    left_hand = mask_polygon(
        (width, height),
        [(320, 710), (250, 740), (250, 820), (290, 900), (325, 920),
         (340, 850), (335, 760)],
    )
    mirror = lambda points: [(width - x, y) for x, y in points]
    right_upper = mask_polygon((width, height), mirror([(432, 260), (300, 265), (225, 350), (210, 500), (245, 590), (365, 585), (420, 500), (445, 330)]))
    right_fore = mask_polygon((width, height), mirror([(420, 535), (245, 560), (215, 700), (250, 780), (320, 805), (365, 760), (430, 690), (435, 600)]))
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
                    "full.pelvis",
                    "full.torso",
                    "full.spine",
                    "full.neck",
                    "full.head",
                    "full.face",
                    "full.eye.l",
                    "full.eye.r",
                    "full.brow.l",
                    "full.brow.r",
                    "full.mouth",
                    "full.hair.l",
                    "full.hair.r",
                    "full.hair.back.l",
                    "full.hair.back.r",
                    "full.shoulder.l",
                    "full.shoulder.r",
                    "full.clavicle.l",
                    "full.clavicle.r",
                    "full.arm-l.upper",
                    "full.arm-l.fore",
                    "full.arm-l.hand",
                    "full.arm-l.thumb", "full.arm-l.thumb.1", "full.arm-l.thumb.2",
                    "full.arm-l.index", "full.arm-l.index.1", "full.arm-l.index.2",
                    "full.arm-l.middle", "full.arm-l.middle.1", "full.arm-l.middle.2",
                    "full.arm-l.ring", "full.arm-l.ring.1", "full.arm-l.ring.2",
                    "full.arm-l.little", "full.arm-l.little.1", "full.arm-l.little.2",
                    "full.arm-r.upper",
                    "full.arm-r.fore",
                    "full.arm-r.hand",
                    "full.arm-r.thumb", "full.arm-r.thumb.1", "full.arm-r.thumb.2",
                    "full.arm-r.index", "full.arm-r.index.1", "full.arm-r.index.2",
                    "full.arm-r.middle", "full.arm-r.middle.1", "full.arm-r.middle.2",
                    "full.arm-r.ring", "full.arm-r.ring.1", "full.arm-r.ring.2",
                    "full.arm-r.little", "full.arm-r.little.1", "full.arm-r.little.2",
                    "full.leg-l.upper", "full.leg-l.knee",
                    "full.leg-l.lower",
                    "full.leg-l.ankle", "full.leg-l.foot", "full.leg-l.toe.l", "full.leg-l.toe.m", "full.leg-l.toe.r",
                    "full.leg-r.upper", "full.leg-r.knee",
                    "full.leg-r.lower",
                    "full.leg-r.ankle", "full.leg-r.foot", "full.leg-r.toe.l", "full.leg-r.toe.m", "full.leg-r.toe.r",
                    "full.coat-l",
                    "full.coat-r",
                    "full.coat-l.front",
                    "full.coat-r.front",
                ],
                "skeleton": {
                    "root": "full.root",
                    "neutralPolicy": "all visual layers remain sourced from source-nomi-master.png",
                    "anchorOnly": [
                        "full.pelvis", "full.spine", "full.face", "full.eye.l", "full.eye.r",
                        "full.brow.l", "full.brow.r", "full.mouth", "full.hair.l", "full.hair.r",
                        "full.hair.back.l", "full.hair.back.r", "full.shoulder.l",
                        "full.shoulder.r", "full.clavicle.l", "full.clavicle.r", "full.coat-l.front",
                        "full.coat-r.front", "full.leg-l.knee", "full.leg-l.ankle",
                        "full.leg-l.toe.l", "full.leg-l.toe.m", "full.leg-l.toe.r",
                        "full.leg-r.knee", "full.leg-r.ankle", "full.leg-r.toe.l",
                        "full.leg-r.toe.m", "full.leg-r.toe.r",
                        "full.arm-l.thumb", "full.arm-l.thumb.1", "full.arm-l.thumb.2",
                        "full.arm-l.index", "full.arm-l.index.1", "full.arm-l.index.2",
                        "full.arm-l.middle", "full.arm-l.middle.1", "full.arm-l.middle.2",
                        "full.arm-l.ring", "full.arm-l.ring.1", "full.arm-l.ring.2",
                        "full.arm-l.little", "full.arm-l.little.1", "full.arm-l.little.2",
                        "full.arm-r.thumb", "full.arm-r.thumb.1", "full.arm-r.thumb.2",
                        "full.arm-r.index", "full.arm-r.index.1", "full.arm-r.index.2",
                        "full.arm-r.middle", "full.arm-r.middle.1", "full.arm-r.middle.2",
                        "full.arm-r.ring", "full.arm-r.ring.1", "full.arm-r.ring.2",
                        "full.arm-r.little", "full.arm-r.little.1", "full.arm-r.little.2",
                    ],
                    "visualBones": [
                        "full.torso", "full.neck", "full.head", "full.arm-l.upper", "full.arm-l.fore",
                        "full.arm-l.hand", "full.arm-r.upper", "full.arm-r.fore", "full.arm-r.hand",
                        "full.leg-l.upper", "full.leg-l.lower", "full.leg-l.foot", "full.leg-r.upper",
                        "full.leg-r.lower", "full.leg-r.foot", "full.coat-l", "full.coat-r",
                    ],
                },
                "materialLayers": {
                    "full.neutral": {
                        "asset": "reference/svg-rig/fullbody-base-no-head-arms.png",
                        "bone": "full.torso",
                        "source": "source-nomi-master.png",
                        "kind": "mother-derived-backfill",
                    },
                    "full.head": {
                        "asset": "reference/svg-rig/head.png",
                        "bone": "full.head",
                        "source": "source-nomi-master.png",
                        "kind": "mother-derived-crop",
                    },
                    "full.arm-l": {
                        "asset": "reference/svg-rig/arm-l-upper.png,arm-l-fore.png,arm-l-hand.png",
                        "bone": "full.arm-l.upper>full.arm-l.fore>full.arm-l.hand",
                        "source": "source-nomi-master.png",
                        "kind": "mother-derived-segments",
                    },
                    "full.arm-r": {
                        "asset": "reference/svg-rig/arm-r-upper.png,arm-r-fore.png,arm-r-hand.png",
                        "bone": "full.arm-r.upper>full.arm-r.fore>full.arm-r.hand",
                        "source": "source-nomi-master.png",
                        "kind": "mother-derived-segments",
                    },
                    "full.face": {
                        "asset": "reference/svg-rig/head.png",
                        "bone": "full.face/full.eye.l/full.eye.r/full.brow.l/full.brow.r/full.mouth",
                        "source": "source-nomi-master.png",
                        "kind": "anchor-only-until-feature-mattes-are-authored",
                    },
                    "full.hair": {
                        "asset": "reference/svg-rig/head.png",
                        "bone": "full.hair.l/full.hair.r",
                        "source": "source-nomi-master.png",
                        "kind": "anchor-only-until-strand-mattes-are-authored",
                    },
                    "full.lower-body": {
                        "asset": "reference/svg-rig/fullbody-base-no-head-arms.png",
                        "bone": "full.pelvis/full.leg-l.upper>full.leg-l.lower>full.leg-l.foot/full.leg-r.upper>full.leg-r.lower>full.leg-r.foot",
                        "source": "source-nomi-master.png",
                        "kind": "mother-derived-backfill",
                    },
                    "full.coat": {
                        "asset": "reference/svg-rig/fullbody-base-no-head-arms.png",
                        "bone": "full.coat-l/full.coat-r",
                        "source": "source-nomi-master.png",
                        "kind": "anchor-only-front-panels",
                    },
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
