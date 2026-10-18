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

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


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


def mask_box(size: tuple[int, int], box: tuple[int, int, int, int]) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rectangle(box, fill=255)
    return mask


def foreground_alpha(image: Image.Image, threshold: int = 128) -> Image.Image:
    """Keep only opaque character pixels from the approved mother image.

    The mother PNG contains a soft, semi-transparent orange/black halo.  That halo
    is useful for the static preview but must not be allowed into a moving arm or
    coat layer: when the bone rotates it becomes a detached glowing shard.  Every
    production crop is therefore multiplied by this hard foreground matte.
    """

    return image.getchannel("A").point(lambda value: 255 if value >= threshold else 0)


def intersect(*masks: Image.Image) -> Image.Image:
    result = masks[0].copy()
    for mask in masks[1:]:
        result = ImageChops.multiply(result, mask)
    return result


def component_mask(
    size: tuple[int, int],
    points: list[tuple[int, int]],
    source_alpha: Image.Image,
) -> Image.Image:
    """Build a polygon layer mask constrained to the source foreground."""

    return intersect(mask_polygon(size, points), source_alpha)


def mirror_points(points: list[tuple[int, int]], width: int) -> list[tuple[int, int]]:
    return [(width - x, y) for x, y in points]


def skin_tone_mask(image: Image.Image) -> Image.Image:
    """Select the warm, pale skin pixels inside a geometric arm region.

    Geometry alone also captures the orange shoulder trim.  The approved mother
    image has enough colour separation to remove that trim without repainting:
    skin keeps a high blue-to-green ratio, while the orange fabric does not.
    """

    rgba = image.load()
    mask = Image.new("L", image.size, 0)
    output = mask.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = rgba[x, y]
            if (
                alpha >= 128
                and red >= 150
                and green >= 100
                and blue >= 80
                and red - green >= 5
                and green - blue >= 3
                and blue * 100 >= green * 78
            ):
                output[x, y] = 255
    return mask


def make_layers(source: Path, out: Path) -> dict[str, list[int]]:
    image = Image.open(source).convert("RGBA")
    width, height = image.size

    # The approved mother image contains a soft light halo around the character.
    # That halo is part of the presentation, not character geometry.  Keep only
    # the solid foreground before making any movable crop; otherwise the glow
    # becomes a detached, bright shard when a bone rotates.
    original_alpha = image.getchannel("A")
    foreground = foreground_alpha(image)
    image.putalpha(ImageChops.multiply(original_alpha, foreground))

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

    # Split the old three large arm crops into visual layers.  Every layer is a
    # masked crop of the mother image; no pixels are redrawn.  The coat tail is
    # deliberately kept out of the forearm chain so it can follow the torso.
    left_coat = mask_polygon(
        (width, height),
        [(378, 500), (455, 520), (470, 1005), (344, 990), (334, 820),
         (340, 680), (355, 575)],
    )
    # The tail sits behind the black shorts and belt.  Cut that torso-facing
    # strip out so the coat layer never carries a rectangular piece of the body.
    left_coat = ImageChops.subtract(
        left_coat,
        mask_polygon((width, height), [(325, 500), (382, 500), (382, 820), (344, 820)]),
    )
    right_coat = mask_polygon(
        (width, height),
        mirror_points([(378, 500), (455, 520), (470, 1005), (344, 990), (334, 820),
                       (340, 680), (355, 575)], width),
    )
    right_coat = ImageChops.subtract(
        right_coat,
        mask_polygon((width, height), mirror_points([(325, 500), (382, 500), (382, 820), (344, 820)], width)),
    )
    skin_colors = skin_tone_mask(image)
    left_skin = intersect(mask_polygon(
        (width, height),
        # Exposed upper-arm skin sits between the orange shoulder cap and the
        # black torso.  The earlier narrow polygon left a skin crescent inside
        # the coat crop, which became a visible ghost when the coat moved.
        [(375, 275), (415, 280), (420, 315), (416, 350), (405, 378),
         (390, 388), (372, 378), (360, 350), (360, 310)],
    ), skin_colors)
    # Stop at the sleeve opening; the pale triangular fabric below this line is
    # owned by the sleeve layer and must not travel with the upper-arm skin.
    left_skin = ImageChops.subtract(
        left_skin,
        mask_polygon((width, height), [(340, 375), (435, 375), (435, 450), (340, 450)]),
    )
    right_skin = ImageOps.mirror(left_skin)
    left_upper_cloth = ImageChops.subtract(left_upper, left_skin)
    right_upper_cloth = ImageChops.subtract(right_upper, right_skin)
    left_fore_sleeve = mask_polygon(
        (width, height),
        [(205, 470), (365, 470), (350, 550), (328, 625), (325, 700),
         (345, 730), (270, 744), (218, 690), (200, 575)],
    )
    right_fore_sleeve = mask_polygon((width, height), [(width - x, y) for x, y in [(205, 470), (365, 470), (350, 550), (328, 625), (325, 700), (345, 730), (270, 744), (218, 690), (200, 575)]])
    left_cuff = mask_polygon((width, height), [(240, 690), (365, 690), (370, 752), (350, 782), (250, 782), (230, 750)])
    right_cuff = mask_polygon((width, height), [(width - x, y) for x, y in [(240, 690), (365, 690), (370, 752), (350, 782), (250, 782), (230, 750)]])
    # Fine visual layers.  These overlap by a few pixels at seams so a rotated
    # bone never exposes a triangular hole.  They are still all sampled from the
    # mother image; the overlap is source-pixel duplication, not repainting.
    left_coat_shoulder = mask_polygon(
        (width, height),
        [(308, 358), (350, 326), (402, 349), (428, 382), (407, 427),
         (365, 440), (330, 424), (298, 398)],
    )
    left_coat_shoulder = ImageChops.subtract(left_coat_shoulder, left_skin)
    left_sleeve_upper = mask_polygon(
        (width, height),
        [(282, 425), (395, 418), (405, 470), (385, 555), (330, 590),
         (274, 551), (250, 470)],
    )
    left_sleeve_upper = ImageChops.subtract(left_sleeve_upper, left_skin)
    left_coat_shoulder = ImageChops.subtract(left_coat_shoulder, left_sleeve_upper)
    left_sleeve_lower = mask_polygon(
        (width, height),
        [(250, 500), (385, 525), (390, 625), (372, 706), (326, 741),
         (270, 718), (232, 650), (224, 565)],
    )
    left_hand_detail = mask_polygon(
        (width, height),
        [(277, 731), (326, 726), (351, 770), (347, 835), (326, 884),
         (297, 866), (280, 820)],
    )
    left_palm = mask_polygon(
        (width, height),
        [(284, 760), (330, 756), (342, 800), (333, 842), (309, 862),
         (287, 830)],
    )
    left_fingers = {
        "thumb": mask_polygon((width, height), [(284, 775), (302, 785), (303, 839), (289, 855), (278, 820)]),
        "index": mask_polygon((width, height), [(305, 758), (319, 758), (320, 812), (311, 838), (303, 812)]),
        "middle": mask_polygon((width, height), [(319, 755), (333, 758), (335, 815), (326, 843), (318, 813)]),
        "ring": mask_polygon((width, height), [(331, 763), (345, 772), (344, 820), (334, 846), (327, 814)]),
        "little": mask_polygon((width, height), [(343, 778), (354, 791), (349, 828), (339, 842), (336, 814)]),
    }

    right_coat_shoulder = mask_polygon((width, height), mirror_points([(308, 358), (350, 326), (402, 349), (428, 382), (407, 427), (365, 440), (330, 424), (298, 398)], width))
    right_coat_shoulder = ImageChops.subtract(right_coat_shoulder, right_skin)
    right_sleeve_upper = mask_polygon((width, height), mirror_points([(282, 425), (395, 418), (405, 470), (385, 555), (330, 590), (274, 551), (250, 470)], width))
    right_sleeve_upper = ImageChops.subtract(right_sleeve_upper, right_skin)
    right_coat_shoulder = ImageChops.subtract(right_coat_shoulder, right_sleeve_upper)
    right_sleeve_lower = mask_polygon((width, height), mirror_points([(250, 500), (385, 525), (390, 625), (372, 706), (326, 741), (270, 718), (232, 650), (224, 565)], width))
    right_hand_detail = mask_polygon((width, height), mirror_points([(277, 731), (326, 726), (351, 770), (347, 835), (326, 884), (297, 866), (280, 820)], width))
    right_palm = mask_polygon((width, height), mirror_points([(284, 760), (330, 756), (342, 800), (333, 842), (309, 862), (287, 830)], width))
    # Mirror the left finger masks without duplicating their point tables.
    right_fingers = {name: ImageOps.mirror(mask) for name, mask in left_fingers.items()}

    left_movable = left_arm
    for layer in (
        left_coat,
        left_coat_shoulder,
        left_sleeve_upper,
        left_sleeve_lower,
        left_cuff,
        left_hand_detail,
    ):
        left_movable = ImageChops.lighter(left_movable, layer)
    right_movable = right_arm
    for layer in (
        right_coat,
        right_coat_shoulder,
        right_sleeve_upper,
        right_sleeve_lower,
        right_cuff,
        right_hand_detail,
    ):
        right_movable = ImageChops.lighter(right_movable, layer)
    head = mask_polygon(
        (width, height),
        [
            (512, 0), (430, 0), (350, 42), (300, 112), (270, 200),
            (286, 278), (340, 320), (410, 334), (430, 358), (594, 358),
            (614, 334), (684, 320), (738, 278), (754, 200), (724, 112),
            (674, 42), (594, 0),
        ],
    )
    # The base layer must not carry a second, static copy of any movable part.
    # Earlier builds removed only the head, so the raster body still contained
    # sleeves, hands, and coat shoulders underneath the bone-driven crops. That
    # made an animated arm look detached because the old arm remained visible.
    # Use the exact visual mattes here; the broad arm polygons are only overlap
    # guides and would incorrectly erase the torso if used as the cutout.
    left_visual = left_coat
    for layer in (left_skin, left_coat_shoulder, left_sleeve_upper,
                  left_sleeve_lower, left_cuff, left_hand_detail, left_palm,
                  *left_fingers.values()):
        left_visual = ImageChops.lighter(left_visual, layer)
    right_visual = right_coat
    for layer in (right_skin, right_coat_shoulder, right_sleeve_upper,
                  right_sleeve_lower, right_cuff, right_hand_detail, right_palm,
                  *right_fingers.values()):
        right_visual = ImageChops.lighter(right_visual, layer)
    combined = ImageChops.lighter(head, left_visual)
    combined = ImageChops.lighter(combined, right_visual)
    base = image.copy()
    alpha = base.getchannel("A")
    alpha = Image.composite(Image.new("L", (width, height), 0), alpha, combined)
    base.putalpha(alpha)
    base.save(out / "fullbody-base-no-head-arms.png")
    # Keep a mother-derived torso/side backfill beneath the movable arms.  The
    # source image has no hidden pixels behind the sleeves, so this central mask
    # preserves the visible tank top, belt, and shorts edge when an arm swings
    # away instead of exposing a black hole.  It is clipped away from the outer
    # sleeve silhouette and is drawn below the arm bones in the Rive scene.
    backfill_mask = mask_polygon(
        (width, height),
        [(350, 245), (674, 245), (685, 330), (670, 570), (660, 830),
         (364, 830), (354, 570), (339, 330)],
    ).filter(ImageFilter.MaxFilter(61))
    backfill = image.copy()
    # Only retain the dark torso/shorts pixels in this underlay.  Bright sleeve
    # and skin pixels are already owned by the moving layers; copying them into
    # the stationary underlay would create a ghost arm when it swings outward.
    dark = Image.new("L", (width, height), 0)
    dark_px = dark.load()
    rgba_px = image.load()
    for yy in range(height):
        for xx in range(width):
            red, green, blue, alpha_value = rgba_px[xx, yy]
            if alpha_value >= 128 and max(red, green, blue) <= 115:
                dark_px[xx, yy] = 255
    backfill.putalpha(ImageChops.multiply(backfill.getchannel("A"), ImageChops.multiply(backfill_mask, dark)))
    backfill.save(out / "body-backfill.png")
    # Remove the superseded pre-head split so a rebuild cannot leave a stale layer
    # that looks like a production asset.
    old_base = out / "fullbody-base-no-arms.png"
    if old_base.exists():
        old_base.unlink()

    boxes = {
        "arm-l-shoulder-skin": [315, 250, 470, 465],
        "arm-l-cuff": [215, 665, 390, 815],
        "coat-l-shoulder": [285, 300, 450, 495],
        "sleeve-l-upper": [230, 365, 420, 610],
        "sleeve-l-lower": [205, 485, 415, 760],
        "hand-l-palm": [265, 740, 360, 885],
        "coat-l-tail": [300, 420, 480, 1020],
        "arm-r-shoulder-skin": [width - 470, 250, width - 315, 465],
        "arm-r-cuff": [width - 390, 665, width - 215, 815],
        "coat-r-shoulder": [width - 450, 300, width - 285, 495],
        "sleeve-r-upper": [width - 420, 365, width - 230, 610],
        "sleeve-r-lower": [width - 415, 485, width - 205, 760],
        "hand-r-palm": [width - 360, 740, width - 265, 885],
        "coat-r-tail": [width - 480, 420, width - 300, 1020],
        "head": [250, 0, 780, 370],
    }
    masks = {
        "arm-l-shoulder-skin": left_skin,
        "arm-l-cuff": left_cuff,
        "coat-l-shoulder": left_coat_shoulder,
        "sleeve-l-upper": left_sleeve_upper,
        "sleeve-l-lower": left_sleeve_lower,
        "hand-l-palm": left_palm,
        "coat-l-tail": left_coat,
        "arm-r-shoulder-skin": right_skin,
        "arm-r-cuff": right_cuff,
        "coat-r-shoulder": right_coat_shoulder,
        "sleeve-r-upper": right_sleeve_upper,
        "sleeve-r-lower": right_sleeve_lower,
        "hand-r-palm": right_palm,
        "coat-r-tail": right_coat,
    }
    # Finger mattes are deliberately separate source crops.  They are not
    # painted replacements; each one is the exact mother-image pixels under the
    # corresponding finger polygon, ready to be parented to a three-segment Rive
    # finger chain later.
    for finger_name, finger_mask in left_fingers.items():
        key = f"hand-l-{finger_name}"
        boxes[key] = [265, 740, 365, 890]
        masks[key] = finger_mask
    for finger_name, finger_mask in right_fingers.items():
        key = f"hand-r-{finger_name}"
        boxes[key] = [width - 365, 740, width - 265, 890]
        masks[key] = finger_mask
    for name, box in boxes.items():
        crop = image.crop(tuple(box))
        if name in masks:
            crop.putalpha(ImageChops.multiply(crop.getchannel("A"), masks[name].crop(tuple(box))))
        crop.save(out / f"{name}.png")
    # Remove the superseded broad crops so the project cannot accidentally keep
    # using a sleeve-plus-hand image after this rebuild.
    for old_name in (
        "arm-l-upper.png", "arm-l-fore.png", "arm-l-hand.png", "arm-r-upper.png", "arm-r-fore.png", "arm-r-hand.png",
        "arm-l-upper-cloth.png", "arm-l-fore-sleeve.png", "arm-r-upper-cloth.png", "arm-r-fore-sleeve.png",
    ):
        old_path = out / old_name
        if old_path.exists():
            old_path.unlink()
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
                    "full.arm-l.rig",
                    "full.arm-l.upper",
                    "full.coat-l.shoulder", "full.sleeve-l.upper",
                    "full.arm-l.fore",
                    "full.sleeve-l.lower", "full.sleeve-l.cuff",
                    "full.arm-l.hand",
                    "full.arm-l.thumb", "full.arm-l.thumb.1", "full.arm-l.thumb.2",
                    "full.arm-l.index", "full.arm-l.index.1", "full.arm-l.index.2",
                    "full.arm-l.middle", "full.arm-l.middle.1", "full.arm-l.middle.2",
                    "full.arm-l.ring", "full.arm-l.ring.1", "full.arm-l.ring.2",
                    "full.arm-l.little", "full.arm-l.little.1", "full.arm-l.little.2",
                    "full.arm-r.rig",
                    "full.arm-r.upper",
                    "full.coat-r.shoulder", "full.sleeve-r.upper",
                    "full.arm-r.fore",
                    "full.sleeve-r.lower", "full.sleeve-r.cuff",
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
                        "full.torso", "full.neck", "full.head", "full.arm-l.rig", "full.arm-l.upper",
                        "full.coat-l.shoulder", "full.sleeve-l.upper", "full.arm-l.fore", "full.sleeve-l.lower",
                        "full.sleeve-l.cuff", "full.arm-l.hand", "full.arm-r.rig", "full.arm-r.upper",
                        "full.coat-r.shoulder", "full.sleeve-r.upper", "full.arm-r.fore", "full.sleeve-r.lower",
                        "full.sleeve-r.cuff", "full.arm-r.hand",
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
                    "full.body.backfill": {
                        "asset": "reference/svg-rig/body-backfill.png",
                        "bone": "full.root",
                        "source": "source-nomi-master.png",
                        "kind": "mother-derived-torso-underlay",
                    },
                    "full.head": {
                        "asset": "reference/svg-rig/head.png",
                        "bone": "full.head",
                        "source": "source-nomi-master.png",
                        "kind": "mother-derived-crop",
                    },
                    "full.arm-l": {
                        "asset": "reference/svg-rig/arm-l-shoulder-skin.png,coat-l-shoulder.png,sleeve-l-upper.png,sleeve-l-lower.png,arm-l-cuff.png,hand-l-palm.png,hand-l-thumb.png,hand-l-index.png,hand-l-middle.png,hand-l-ring.png,hand-l-little.png",
                        "bone": "full.arm-l.rig>full.arm-l.upper/full.coat-l.shoulder/full.sleeve-l.upper>full.arm-l.fore/full.sleeve-l.lower/full.sleeve-l.cuff>full.arm-l.hand/full.arm-l.thumb|index|middle|ring|little",
                        "source": "source-nomi-master.png",
                        "kind": "mother-derived-segments-with-independent-clothing",
                    },
                    "full.arm-r": {
                        "asset": "reference/svg-rig/arm-r-shoulder-skin.png,coat-r-shoulder.png,sleeve-r-upper.png,sleeve-r-lower.png,arm-r-cuff.png,hand-r-palm.png,hand-r-thumb.png,hand-r-index.png,hand-r-middle.png,hand-r-ring.png,hand-r-little.png",
                        "bone": "full.arm-r.rig>full.arm-r.upper/full.coat-r.shoulder/full.sleeve-r.upper>full.arm-r.fore/full.sleeve-r.lower/full.sleeve-r.cuff>full.arm-r.hand/full.arm-r.thumb|index|middle|ring|little",
                        "source": "source-nomi-master.png",
                        "kind": "mother-derived-segments-with-independent-clothing",
                    },
                    "full.clothing": {
                        "asset": "reference/svg-rig/coat-l-shoulder.png,coat-r-shoulder.png,sleeve-l-upper.png,sleeve-l-lower.png,arm-l-cuff.png,sleeve-r-upper.png,sleeve-r-lower.png,arm-r-cuff.png",
                        "bone": "full.coat-l.shoulder/full.sleeve-l.upper/full.sleeve-l.lower/full.sleeve-l.cuff/full.coat-r.shoulder/full.sleeve-r.upper/full.sleeve-r.lower/full.sleeve-r.cuff",
                        "source": "source-nomi-master.png",
                        "kind": "mother-derived-independent-clothing-bones",
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
                        "asset": "reference/svg-rig/coat-l-tail.png,coat-r-tail.png",
                        "bone": "full.coat-l/full.coat-r",
                        "source": "source-nomi-master.png",
                        "kind": "independent-mother-derived-tail-panels",
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
