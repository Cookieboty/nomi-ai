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


def remove_small_alpha_components(image: Image.Image, minimum_area: int) -> Image.Image:
    """Drop isolated matte islands from a moving crop.

    A few legacy shoulder crops contain one-pixel source remnants outside the
    actual silhouette. They are invisible in the neutral pose but become obvious
    when the shoulder rotates. Keep the original RGB pixels and remove only alpha
    components smaller than the requested area.
    """

    alpha = image.getchannel("A")
    width, height = image.size
    pixels = alpha.load()
    visited: set[tuple[int, int]] = set()
    keep = Image.new("L", image.size, 0)
    keep_pixels = keep.load()
    for y in range(height):
        for x in range(width):
            if (x, y) in visited or pixels[x, y] < 32:
                continue
            stack = [(x, y)]
            visited.add((x, y))
            component: list[tuple[int, int]] = []
            while stack:
                px, py = stack.pop()
                component.append((px, py))
                for nx, ny in (
                    (px - 1, py - 1), (px, py - 1), (px + 1, py - 1),
                    (px - 1, py),                     (px + 1, py),
                    (px - 1, py + 1), (px, py + 1), (px + 1, py + 1),
                ):
                    if (
                        0 <= nx < width
                        and 0 <= ny < height
                        and (nx, ny) not in visited
                        and pixels[nx, ny] >= 32
                    ):
                        visited.add((nx, ny))
                        stack.append((nx, ny))
            if len(component) >= minimum_area:
                for px, py in component:
                    keep_pixels[px, py] = 255
    image.putalpha(ImageChops.multiply(alpha, keep))
    return image


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
                and red - green >= 12
                and green - blue >= 6
                and red - blue >= 20
                and blue * 100 >= green * 78
            ):
                output[x, y] = 255
    return mask


def detail_tone_mask(image: Image.Image, kind: str) -> Image.Image:
    """Select garment detail pixels without inventing new artwork.

    The mother image is painterly, so a hard vector trace would destroy the
    fabric shading.  These mattes keep the exact source pixels while allowing
    dark straps, orange panels and their highlights to live on separate Rive
    bones.  The alpha threshold prevents the surrounding glow/background from
    being mistaken for a garment detail.
    """

    rgba = image.load()
    mask = Image.new("L", image.size, 0)
    output = mask.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = rgba[x, y]
            if alpha < 128:
                continue
            if kind == "dark":
                # Buckles, straps and ink outlines. Keep warm orange out of the
                # dark pass even where its shadow is close to black.
                selected = max(red, green, blue) <= 112 and red - blue <= 28
            elif kind == "orange":
                selected = (
                    red >= 128
                    and red >= green * 1.16
                    and green >= blue * 1.35
                    and red - blue >= 45
                )
            else:
                raise ValueError(f"unknown detail tone: {kind}")
            if selected:
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
    # The inner sleeve edge is bright fabric immediately beside the dark tank
    # top.  The broad sleeve polygon intentionally stops short of the torso,
    # but that left a narrow white seam outside the moving matte.  Keep this
    # source-pixel corridor with the sleeve so the base cutout cannot expose a
    # dark horizontal gap at the shoulder.
    white_fabric = Image.new("L", (width, height), 0)
    white_px = white_fabric.load()
    src_px = image.load()
    for yy in range(height):
        for xx in range(width):
            red, green, blue, alpha_value = src_px[xx, yy]
            if alpha_value >= 128 and red >= 165 and green >= 165 and blue >= 165 and max(red, green, blue) - min(red, green, blue) <= 48:
                white_px[xx, yy] = 255
    left_skin = intersect(mask_polygon(
        (width, height),
        # Capture the complete exposed shoulder/upper-arm silhouette.  The old
        # narrow polygon stopped before the outside shoulder edge, leaving a
        # skin shard inside coat-l-shoulder when the sleeve rotated.
        [(350, 245), (430, 245), (455, 285), (454, 335), (442, 385),
         (428, 425), (395, 435), (365, 405), (345, 360), (345, 300)],
    ), skin_colors)
    # Stop at the sleeve opening; the pale triangular fabric below this line is
    # owned by the sleeve layer and must not travel with the upper-arm skin.
    left_skin = ImageChops.subtract(
        left_skin,
        mask_polygon((width, height), [(340, 382), (445, 382), (445, 450), (340, 450)]),
    )
    right_skin = ImageOps.mirror(left_skin)
    # Keep a compact shoulder cap on the clavicle and let the outer upper-arm
    # skin follow the sleeve root.  Using one broad skin crop for both made a
    # raised arm leave a pale wing attached to the torso.
    left_skin_static = intersect(
        # Keep only the clavicle cap on the torso.  The outer shoulder and
        # upper-arm skin must travel with the arm root; a broad static cap
        # becomes a detached pale wing as soon as the arm is raised.
        mask_polygon((width, height), [(378, 250), (425, 250), (435, 280),
                                        (430, 315), (414, 338), (392, 342),
                                        (380, 320), (372, 282)]),
        skin_colors,
    )
    right_skin_static = ImageOps.mirror(left_skin_static)
    left_skin_moving = ImageChops.subtract(left_skin, left_skin_static)
    right_skin_moving = ImageChops.subtract(right_skin, right_skin_static)
    left_upper_cloth = ImageChops.subtract(left_upper, left_skin)
    right_upper_cloth = ImageChops.subtract(right_upper, right_skin)
    left_fore_sleeve = mask_polygon(
        (width, height),
        [(205, 470), (365, 470), (350, 550), (328, 625), (325, 700),
         (345, 730), (270, 744), (218, 690), (200, 575)],
    )
    right_fore_sleeve = mask_polygon((width, height), [(width - x, y) for x, y in [(205, 470), (365, 470), (350, 550), (328, 625), (325, 700), (345, 730), (270, 744), (218, 690), (200, 575)]])
    left_cuff = mask_polygon((width, height), [(215, 670), (380, 670), (390, 760), (365, 810), (235, 810), (205, 755)])
    right_cuff = mask_polygon((width, height), [(width - x, y) for x, y in [(215, 670), (380, 670), (390, 760), (365, 810), (235, 810), (205, 755)]])
    # Fine visual layers.  These overlap by a few pixels at seams so a rotated
    # bone never exposes a triangular hole.  They are still all sampled from the
    # mother image; the overlap is source-pixel duplication, not repainting.
    # ROUND5: expand coat further + raise sleeve top so coat∩sleeve share a
    # ~24–36px soft underlap (ROUND4 ~12–20px still left orange rim cutting the
    # white sleeve and sawtooth gaps on character-left / screen-right).
    left_coat_shoulder = mask_polygon(
        (width, height),
        [(290, 328), (332, 292), (392, 300), (435, 335), (455, 380),
         (442, 435), (410, 462), (360, 472), (310, 458), (282, 420), (278, 365)],
    )
    # Remove every skin-coloured source pixel from garment crops.  A geometric
    # subtraction alone still left a pale shoulder crescent in the coat layer
    # where the painted silhouette crossed the polygon edge.
    # Do not remove warm white fabric with the skin heuristic.  Keeping the
    # source pixels across this seam gives the moving shoulder a continuous
    # silhouette; the static clavicle cap is drawn underneath at neutral.
    left_coat_shoulder = left_coat_shoulder.filter(ImageFilter.MaxFilter(9))
    left_sleeve_upper = mask_polygon(
        (width, height),
        # ROUND5: raise top (~365) deeper under orange collar for thicker underlap.
        # Extended past the elbow (y≈535–560) so upper/fore share a soft blend zone.
        [(270, 365), (405, 358), (425, 445), (412, 555), (370, 640), (310, 655),
         (255, 610), (242, 470), (248, 410)],
    )
    left_sleeve_upper = left_sleeve_upper.filter(ImageFilter.MaxFilter(9))
    left_sleeve_upper = ImageChops.lighter(
        left_sleeve_upper,
        intersect(
            mask_polygon((width, height), [(392, 400), (445, 415), (448, 510),
                                            (430, 550), (398, 548), (390, 470)]),
            white_fabric,
        ),
    )
    # Soft subtract: only the eroded sleeve CORE leaves the coat, so a rim of
    # shared mother pixels remains under the orange collar (coat draws on top).
    # ROUND5: deeper erosion (~12–18px) so idle mesh micro-drift cannot open a
    # cream sawtooth under the orange collar rim.
    sleeve_core = left_sleeve_upper.point(lambda p: 255 if p >= 128 else 0)
    for _ in range(3):
        sleeve_core = sleeve_core.filter(ImageFilter.MinFilter(13))
    left_coat_shoulder = ImageChops.subtract(left_coat_shoulder, sleeve_core)
    left_sleeve_lower = mask_polygon(
        (width, height),
        # Start higher so it overlaps the extended upper sleeve by ~80–100 px.
        [(245, 450), (395, 460), (400, 560), (390, 625), (372, 706), (326, 741),
         (270, 718), (232, 650), (220, 545)],
    ).filter(ImageFilter.MaxFilter(7))
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
        "thumb": mask_polygon((width, height), [(276, 770), (308, 778), (312, 845), (295, 868), (274, 830)]),
        "index": mask_polygon((width, height), [(305, 758), (319, 758), (320, 812), (311, 838), (303, 812)]),
        "middle": mask_polygon((width, height), [(319, 755), (333, 758), (335, 815), (326, 843), (318, 813)]),
        "ring": mask_polygon((width, height), [(331, 763), (345, 772), (344, 820), (334, 846), (327, 814)]),
        "little": mask_polygon((width, height), [(343, 778), (354, 791), (349, 828), (339, 842), (336, 814)]),
    }

    right_coat_shoulder = mask_polygon((width, height), mirror_points([(290, 328), (332, 292), (392, 300), (435, 335), (455, 380), (442, 435), (410, 462), (360, 472), (310, 458), (282, 420), (278, 365)], width))
    right_coat_shoulder = right_coat_shoulder.filter(ImageFilter.MaxFilter(9))
    right_sleeve_upper = mask_polygon((width, height), mirror_points([(270, 365), (405, 358), (425, 445), (412, 555), (370, 640), (310, 655), (255, 610), (242, 470), (248, 410)], width))
    right_sleeve_upper = right_sleeve_upper.filter(ImageFilter.MaxFilter(9))
    right_sleeve_upper = ImageChops.lighter(
        right_sleeve_upper,
        intersect(
            mask_polygon((width, height), mirror_points([(392, 400), (445, 415), (448, 510),
                                                         (430, 550), (398, 548), (390, 470)], width)),
            white_fabric,
        ),
    )
    right_sleeve_core = right_sleeve_upper.point(lambda p: 255 if p >= 128 else 0)
    for _ in range(3):
        right_sleeve_core = right_sleeve_core.filter(ImageFilter.MinFilter(13))
    right_coat_shoulder = ImageChops.subtract(right_coat_shoulder, right_sleeve_core)
    right_sleeve_lower = mask_polygon((width, height), mirror_points([(245, 450), (395, 460), (400, 560), (390, 625), (372, 706), (326, 741), (270, 718), (232, 650), (220, 545)], width))
    right_hand_detail = mask_polygon((width, height), mirror_points([(277, 731), (326, 726), (351, 770), (347, 835), (326, 884), (297, 866), (280, 820)], width))
    right_palm = mask_polygon((width, height), mirror_points([(284, 760), (330, 756), (342, 800), (333, 842), (309, 862), (287, 830)], width))
    # Mirror the left finger masks without duplicating their point tables.
    right_fingers = {name: ImageOps.mirror(mask) for name, mask in left_fingers.items()}

    # The coat-tail polygon overlaps the sleeve in the source image.  If it is
    # exported as one broad crop, moving an arm carries a rectangular sleeve or
    # a detached hand along with the supposedly static tail.  Keep the tail
    # source pixels, but explicitly subtract every movable arm matte before
    # writing the tail asset.  This preserves the exact mother pixels while
    # making the tail a torso-side layer that can safely remain behind the arms.
    left_coat_tail = left_coat.copy()
    for layer in (
        # `left_arm` is the broad source silhouette; the finer mattes below
        # handle seams, but this pass is what removes the outer sleeve edge
        # that falls outside those seam polygons.
        left_arm,
        left_skin,
        left_coat_shoulder,
        left_sleeve_upper,
        left_sleeve_lower,
        left_cuff,
        left_hand_detail,
    ):
        left_coat_tail = ImageChops.subtract(left_coat_tail, layer)
    right_coat_tail = right_coat.copy()
    for layer in (
        right_arm,
        right_skin,
        right_coat_shoulder,
        right_sleeve_upper,
        right_sleeve_lower,
        right_cuff,
        right_hand_detail,
    ):
        right_coat_tail = ImageChops.subtract(right_coat_tail, layer)

    # Partition each garment crop into a light fabric base plus source-pixel
    # detail passes.  The union is exactly the old crop, so neutral remains
    # faithful while the dark straps, orange trim and shoulder cap can be
    # addressed as their own child bones during motion.
    dark_pixels = detail_tone_mask(image, "dark")
    orange_pixels = detail_tone_mask(image, "orange")

    def partition(mask: Image.Image) -> tuple[Image.Image, Image.Image, Image.Image]:
        """Split a garment matte into base fabric plus dark/orange detail passes.

        ROUND3: base keeps the FULL matte (including dark/orange pixels) so the
        white sleeve never has punched holes that open as cream gaps or let the
        orange overlay z-fight through when meshes deform. Dark/orange remain
        optional overlays (straps/trim) drawn on top with matching skin weights.
        """
        dark = intersect(mask, dark_pixels)
        orange = intersect(mask, orange_pixels)
        # Full fabric base — no subtract. Overlays may still sit on top for straps.
        main = mask.copy()
        return main, dark, orange

    # ROUND4: pull stray collar-band orange (outside hard polygons) into coat so
    # the orange lining does not fragment into sleeve/neither gaps.
    collar_band_l = mask_polygon(
        (width, height),
        [(285, 300), (455, 300), (455, 435), (285, 435)],
    ).filter(ImageFilter.MaxFilter(5))
    collar_band_r = ImageOps.mirror(collar_band_l)
    left_coat_shoulder = ImageChops.lighter(
        left_coat_shoulder, intersect(orange_pixels, collar_band_l)
    )
    right_coat_shoulder = ImageChops.lighter(
        right_coat_shoulder, intersect(orange_pixels, collar_band_r)
    )
    # Keep orange out of the deep sleeve (below collar) so the bicep strap stays
    # on the sleeve layer — subtract sleeve core again after the orange absorb.
    left_coat_shoulder = ImageChops.subtract(left_coat_shoulder, sleeve_core)
    right_coat_shoulder = ImageChops.subtract(right_coat_shoulder, right_sleeve_core)

    left_coat_shoulder_main, left_coat_shoulder_dark, left_coat_shoulder_orange = partition(left_coat_shoulder)
    right_coat_shoulder_main, right_coat_shoulder_dark, right_coat_shoulder_orange = partition(right_coat_shoulder)
    left_sleeve_upper_main, left_sleeve_upper_dark, left_sleeve_upper_orange = partition(left_sleeve_upper)
    right_sleeve_upper_main, right_sleeve_upper_dark, right_sleeve_upper_orange = partition(right_sleeve_upper)
    left_sleeve_lower_main, left_sleeve_lower_dark, left_sleeve_lower_orange = partition(left_sleeve_lower)
    right_sleeve_lower_main, right_sleeve_lower_dark, right_sleeve_lower_orange = partition(right_sleeve_lower)

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
    # Keep torso-side coat panels, straps, and tails in the stationary mother
    # layer.  `left_coat` is a broad side-of-body guide used to author the tail
    # crop; using it as the base cutout removes body-locked details that have no
    # matching moving drawable, which leaves black gaps in the neutral pose.
    # Only the visual mattes that are actually parented to arm bones belong in
    # this subtraction.
    left_visual = Image.new("L", (width, height), 0)
    for layer in (left_skin, left_coat_shoulder, left_sleeve_upper,
                  left_sleeve_lower, left_cuff, left_hand_detail, left_palm,
                  *left_fingers.values()):
        left_visual = ImageChops.lighter(left_visual, layer)
    right_visual = Image.new("L", (width, height), 0)
    for layer in (right_skin, right_coat_shoulder, right_sleeve_upper,
                  right_sleeve_lower, right_cuff, right_hand_detail, right_palm,
                  *right_fingers.values()):
        right_visual = ImageChops.lighter(right_visual, layer)
    # `Image.composite` accepts RGBA masks, but uses their colour channels as
    # the selector on some Pillow builds.  The source crops then remain fully
    # opaque even though the matte looks correct when inspected as alpha.  Keep
    # the cutout explicitly in L mode so the static base cannot carry a second
    # copy of the head, sleeves, hands, or coat shoulders behind the bones.
    head_mask = intersect(head, foreground)
    left_visual_mask = intersect(left_visual, foreground)
    right_visual_mask = intersect(right_visual, foreground)
    cutout = ImageChops.lighter(head_mask, left_visual_mask)
    cutout = ImageChops.lighter(cutout, right_visual_mask)
    # The mother image has a warm white sleeve edge immediately inside the
    # outer arm.  It is outside the broad matte at its elbow and otherwise
    # survives in the static base, so an inward arm swing leaves a frozen white
    # strip behind.  Remove only low-saturation fabric pixels in that sleeve
    # corridor; the torso remains untouched and the moving sleeve owns the
    # neutral pixels.
    white_fabric = Image.new("L", (width, height), 0)
    white_px = white_fabric.load()
    src_px = image.load()
    for yy in range(height):
        for xx in range(width):
            red, green, blue, alpha_value = src_px[xx, yy]
            if alpha_value >= 128 and red >= 165 and green >= 165 and blue >= 165 and max(red, green, blue) - min(red, green, blue) <= 48:
                white_px[xx, yy] = 255
    left_white_corridor = mask_polygon((width, height), [(360, 430), (425, 450), (425, 730), (390, 750), (360, 650)])
    right_white_corridor = mask_polygon((width, height), mirror_points([(360, 430), (425, 450), (425, 730), (390, 750), (360, 650)], width))
    cutout = ImageChops.lighter(cutout, intersect(left_white_corridor, white_fabric))
    cutout = ImageChops.lighter(cutout, intersect(right_white_corridor, white_fabric))
    base = image.copy()
    alpha = ImageChops.subtract(base.getchannel("A"), cutout)
    base.putalpha(alpha)
    base.save(out / "fullbody-base-no-head-arms.png")
    # Keep a mother-derived torso/side backfill beneath the movable arms.  The
    # source image has no hidden pixels behind the sleeves, so this central mask
    # preserves the visible tank top, belt, and shorts edge when an arm swings
    # away instead of exposing a black hole.  It is clipped away from the outer
    # sleeve silhouette and is drawn below the arm bones in the Rive scene.
    backfill_mask = mask_polygon(
        (width, height),
        # Keep the underlay inside the torso silhouette.  The arm layers own
        # the outer sleeve corridors; copying those pixels here would leave
        # detached dark straps when an arm opens outward.
        [(420, 340), (604, 340), (604, 650),
         (420, 650)],
    )
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
        "arm-l-upper-skin": [330, 250, 470, 440],
        "arm-l-cuff": [215, 665, 390, 815],
        "coat-l-shoulder": [275, 285, 460, 505],
        "coat-l-shoulder-dark": [275, 285, 460, 505],
        "coat-l-shoulder-orange": [275, 285, 460, 505],
        "sleeve-l-upper": [230, 365, 430, 670],
        "sleeve-l-upper-dark": [230, 365, 430, 670],
        "sleeve-l-upper-orange": [230, 365, 430, 670],
        "sleeve-l-lower": [205, 440, 420, 760],
        "sleeve-l-lower-dark": [205, 440, 420, 760],
        "sleeve-l-lower-orange": [205, 440, 420, 760],
        "hand-l-palm": [265, 740, 360, 885],
        "coat-l-tail": [300, 420, 480, 1020],
        "arm-r-shoulder-skin": [width - 470, 250, width - 315, 465],
        "arm-r-upper-skin": [width - 470, 250, width - 330, 440],
        "arm-r-cuff": [width - 390, 665, width - 215, 815],
        "coat-r-shoulder": [width - 460, 285, width - 275, 505],
        "coat-r-shoulder-dark": [width - 460, 285, width - 275, 505],
        "coat-r-shoulder-orange": [width - 460, 285, width - 275, 505],
        "sleeve-r-upper": [width - 430, 365, width - 230, 670],
        "sleeve-r-upper-dark": [width - 430, 365, width - 230, 670],
        "sleeve-r-upper-orange": [width - 430, 365, width - 230, 670],
        "sleeve-r-lower": [width - 420, 440, width - 205, 760],
        "sleeve-r-lower-dark": [width - 420, 440, width - 205, 760],
        "sleeve-r-lower-orange": [width - 420, 440, width - 205, 760],
        "hand-r-palm": [width - 360, 740, width - 265, 885],
        "coat-r-tail": [width - 480, 420, width - 300, 1020],
        "head": [250, 0, 780, 370],
    }
    masks = {
        "arm-l-shoulder-skin": left_skin_static,
        "arm-l-upper-skin": left_skin_moving,
        "arm-l-cuff": left_cuff,
        "coat-l-shoulder": left_coat_shoulder_main,
        "coat-l-shoulder-dark": left_coat_shoulder_dark,
        "coat-l-shoulder-orange": left_coat_shoulder_orange,
        "sleeve-l-upper": left_sleeve_upper_main,
        "sleeve-l-upper-dark": left_sleeve_upper_dark,
        "sleeve-l-upper-orange": left_sleeve_upper_orange,
        "sleeve-l-lower": left_sleeve_lower_main,
        "sleeve-l-lower-dark": left_sleeve_lower_dark,
        "sleeve-l-lower-orange": left_sleeve_lower_orange,
        "hand-l-palm": left_palm,
        "coat-l-tail": left_coat_tail,
        "arm-r-shoulder-skin": right_skin_static,
        "arm-r-upper-skin": right_skin_moving,
        "arm-r-cuff": right_cuff,
        "coat-r-shoulder": right_coat_shoulder_main,
        "coat-r-shoulder-dark": right_coat_shoulder_dark,
        "coat-r-shoulder-orange": right_coat_shoulder_orange,
        "sleeve-r-upper": right_sleeve_upper_main,
        "sleeve-r-upper-dark": right_sleeve_upper_dark,
        "sleeve-r-upper-orange": right_sleeve_upper_orange,
        "sleeve-r-lower": right_sleeve_lower_main,
        "sleeve-r-lower-dark": right_sleeve_lower_dark,
        "sleeve-r-lower-orange": right_sleeve_lower_orange,
        "hand-r-palm": right_palm,
        "coat-r-tail": right_coat_tail,
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
        # ROUND5: stronger alpha feather on coat shoulders to kill orange rim
        # sawteeth against the white sleeve underlap.
        if name.startswith("coat-") and "shoulder" in name:
            alpha = crop.getchannel("A").filter(ImageFilter.GaussianBlur(radius=1.35))
            crop.putalpha(alpha)
        crop.save(out / f"{name}.png")
    # Remove tiny disconnected remnants from the moving upper-arm skin matte;
    # the torso-locked shoulder cap is exported separately above.
    for name, minimum_area in (
        ("arm-l-upper-skin", 100),
        ("arm-r-upper-skin", 100),
    ):
        layer_path = out / f"{name}.png"
        if layer_path.exists():
            cleaned = remove_small_alpha_components(Image.open(layer_path).convert("RGBA"), minimum_area)
            cleaned.save(layer_path)
    # The mother pose occludes the right thumb behind the palm.  Mirror the left
    # thumb mother-pixels into the right thumb slot so clap/wave finger bones
    # have a visible silhouette (still 100% mother-derived pixels).
    left_thumb = out / "hand-l-thumb.png"
    right_thumb = out / "hand-r-thumb.png"
    if left_thumb.exists() and right_thumb.exists():
        lt = Image.open(left_thumb).convert("RGBA")
        rt = Image.open(right_thumb).convert("RGBA")
        opaque = sum(1 for p in rt.getchannel("A").getdata() if p > 10)
        if opaque < 40:
            mirrored = ImageOps.mirror(lt)
            # Keep any genuine right-thumb sliver on top of the mirrored fill.
            rt = Image.alpha_composite(mirrored, rt)
            rt.save(right_thumb)
    # Remove the superseded broad crops so the project cannot accidentally keep
    # using a sleeve-plus-hand image after this rebuild.
    for old_name in (
        "arm-l-upper.png", "arm-l-fore.png", "arm-l-hand.png", "arm-r-upper.png", "arm-r-fore.png", "arm-r-hand.png",
        "arm-l-upper-cloth.png", "arm-l-fore-sleeve.png", "arm-r-upper-cloth.png", "arm-r-fore-sleeve.png",
    ):
        old_path = out / old_name
        if old_path.exists():
            old_path.unlink()
    # ROUND3: continuous sleeve (upper∪lower) and bent-elbow art from mother pixels.
    # Continuous crop removes the elbow segment seam; bent art is a Solo alternate
    # for clap/wave peaks (warped forearm + crease shading, still mother-sourced).
    import math as _math
    import numpy as _np

    def _save_box_crop(name: str, box: list[int], mask: Image.Image) -> None:
        boxes[name] = box
        crop = image.crop(tuple(box))
        crop.putalpha(ImageChops.multiply(crop.getchannel("A"), mask.crop(tuple(box))))
        crop.save(out / f"{name}.png")

    def _bent_sleeve(side: str, sleeve_mask: Image.Image, box: list[int], bend: float) -> None:
        """Warp forearm around elbow and paint a soft crease from mother whites."""
        x0, y0, x1, y1 = box
        crop = image.crop((x0, y0, x1, y1)).convert("RGBA")
        alpha = ImageChops.multiply(crop.getchannel("A"), sleeve_mask.crop((x0, y0, x1, y1)))
        crop.putalpha(alpha)
        arr = _np.array(crop)
        h, w = arr.shape[:2]
        # Elbow in crop space ≈ 40% down the sleeve (upper→lower join)
        ex = w * (0.55 if side == "l" else 0.45)
        ey = h * 0.38
        # Rotate pixels below elbow around (ex,ey) by bend (inward: L negative, R positive)
        yy, xx = _np.mgrid[0:h, 0:w].astype(_np.float32)
        dx, dy = xx - ex, yy - ey
        # Only warp the lower half (forearm); feather across elbow
        t = _np.clip((yy - (ey - 28)) / 56.0, 0, 1)
        t = t * t * (3 - 2 * t)
        ang = bend * t
        ca, sa = _np.cos(ang), _np.sin(ang)
        # Inverse map: sample from unwarped
        sx = ca * dx + sa * dy + ex
        sy = -sa * dx + ca * dy + ey
        sx = _np.clip(sx, 0, w - 1.001)
        sy = _np.clip(sy, 0, h - 1.001)
        x0i = _np.floor(sx).astype(_np.int32)
        y0i = _np.floor(sy).astype(_np.int32)
        x1i = _np.minimum(x0i + 1, w - 1)
        y1i = _np.minimum(y0i + 1, h - 1)
        fx, fy = sx - x0i, sy - y0i
        out_a = _np.zeros_like(arr)
        for c in range(4):
            v00 = arr[y0i, x0i, c].astype(_np.float32)
            v10 = arr[y0i, x1i, c].astype(_np.float32)
            v01 = arr[y1i, x0i, c].astype(_np.float32)
            v11 = arr[y1i, x1i, c].astype(_np.float32)
            out_a[:, :, c] = (
                v00 * (1 - fx) * (1 - fy)
                + v10 * fx * (1 - fy)
                + v01 * (1 - fx) * fy
                + v11 * fx * fy
            )
        # Crease shading along elbow bisector (darken inner, lighten outer ridge)
        # Inner side is toward torso: for L (screen-left) larger x; for R smaller x
        inward = 1.0 if side == "l" else -1.0
        nx = (xx - ex) * inward
        d = (nx / max(w * 0.22, 1)) ** 2 + ((yy - ey) / 36.0) ** 2
        crease = (-0.18 * _np.exp(-d * 2.2) + 0.08 * _np.exp(-((nx / 40) - 0.7) ** 2) * _np.exp(-((yy - ey) / 28) ** 2))
        crease = crease * t  # only on bent region
        for c in range(3):
            out_a[:, :, c] = _np.clip(out_a[:, :, c] * (1.0 + crease), 0, 255)
        # Fill tiny alpha holes near elbow with nearby opaque fabric (dilate sample)
        a = out_a[:, :, 3]
        hole = (a < 20) & (t > 0.2) & (t < 0.95)
        if hole.any():
            # sample mean of opaque white-ish pixels near elbow
            opaque = a > 80
            ys, xs = _np.where(opaque & (_np.abs(yy - ey) < 50) & (_np.abs(xx - ex) < w * 0.35))
            if len(ys) > 20:
                mean = out_a[ys, xs, :3].mean(axis=0)
                for c in range(3):
                    out_a[:, :, c] = _np.where(hole, mean[c], out_a[:, :, c])
                out_a[:, :, 3] = _np.where(hole, 220, out_a[:, :, 3])
        Image.fromarray(out_a.astype(_np.uint8), "RGBA").save(out / f"sleeve-{side}-bent.png")
        boxes[f"sleeve-{side}-bent"] = box

    left_full_mask = ImageChops.lighter(left_sleeve_upper, left_sleeve_lower)
    right_full_mask = ImageChops.lighter(right_sleeve_upper, right_sleeve_lower)
    # ROUND5: raise full-sleeve box further so deep collar underlap is in crop.
    left_full_box = [205, 320, 430, 760]
    right_full_box = [width - 430, 320, width - 205, 760]
    _save_box_crop("sleeve-l-full", left_full_box, left_full_mask)
    _save_box_crop("sleeve-r-full", right_full_box, right_full_mask)
    # ROUND5: torso-locked white stump under the orange collar. When the arm
    # raises, the skinned sleeve leaves the socket; this mother-pixel patch
    # stays under the coat so the collar never floats over a cream hole.
    # Broad socket patch: collar underlap + inner armpit so raised-arm wave
    # still covers mother pixels under the torso-locked orange collar.
    stump_band_l = mask_polygon(
        (width, height),
        [(255, 320), (440, 310), (470, 400), (465, 490), (400, 530),
         (320, 535), (250, 490), (240, 400)],
    ).filter(ImageFilter.MaxFilter(11))
    stump_band_r = ImageOps.mirror(stump_band_l)
    left_stump = intersect(left_sleeve_upper, stump_band_l)
    right_stump = intersect(right_sleeve_upper, stump_band_r)
    left_stump_box = [235, 300, 480, 550]
    right_stump_box = [width - 480, 300, width - 235, 550]
    _save_box_crop("sleeve-l-stump", left_stump_box, left_stump)
    _save_box_crop("sleeve-r-stump", right_stump_box, right_stump)
    # Also export continuous dark straps (optional overlay) without punching base
    _save_box_crop("sleeve-l-full-dark", left_full_box, intersect(left_full_mask, dark_pixels))
    _save_box_crop("sleeve-r-full-dark", right_full_box, intersect(right_full_mask, dark_pixels))
    # Bent art: ~1.0 rad inward (clap peak). L screen-left bends clockwise (neg in image y-down?);
    # warp sign chosen so forearm swings toward torso centre.
    # ROUND6 wave keeps hang Solo (bent still tears at outward wave angles).
    _bent_sleeve("l", left_full_mask, left_full_box, bend=-1.05)
    _bent_sleeve("r", right_full_mask, right_full_box, bend=1.05)

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
