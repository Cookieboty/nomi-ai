#!/usr/bin/env python3
"""ROUND7: full mother-image decompose — missing layers + bone coverage + selective Mesh.

Crops new face/hair/accessory/leg layers from source-nomi-master.png, punches them
out of head/base to avoid double-draw, wires Images under existing (or new) bones,
and adds Mesh+Skin for continuous leg chains, coat tails, and whole fingers.

Does NOT claim full-body Mesh coverage. Finger phalanx sub-crops skipped (≈6px).
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "rive" / "nomi-complete"
SOURCE = PROJECT / "source-nomi-master.png"
OUT = PROJECT / "reference" / "svg-rig"
SCENE = PROJECT / "scene.rml"
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
META = OUT / "rig-meta.json"

SCALE = 0.8463541666666666
OX, OY = 46.666666666666686, 0.0
GRID = 18.0
ID_START = 9900  # ImageAsset / Image / Mesh / Bone ids for ROUND7


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def foreground_alpha(image: Image.Image, threshold: int = 128) -> Image.Image:
    return image.getchannel("A").point(lambda v: 255 if v >= threshold else 0)


def mask_polygon(size, points) -> Image.Image:
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    return m


def intersect(*masks: Image.Image) -> Image.Image:
    r = masks[0].copy()
    for m in masks[1:]:
        r = ImageChops.multiply(r, m)
    return r


def union(*masks: Image.Image) -> Image.Image:
    r = masks[0].copy()
    for m in masks[1:]:
        r = ImageChops.lighter(r, m)
    return r


def src_to_art(sx: float, sy: float) -> tuple[float, float]:
    return sx * SCALE + OX, sy * SCALE + OY


def save_crop(image: Image.Image, mask: Image.Image, box: list[int], path: Path) -> None:
    crop = image.crop(tuple(box))
    crop.putalpha(ImageChops.multiply(crop.getchannel("A"), mask.crop(tuple(box))))
    crop.save(path)


def skin_tone_mask(image: Image.Image) -> Image.Image:
    rgba = image.load()
    mask = Image.new("L", image.size, 0)
    out = mask.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = rgba[x, y]
            if (
                a >= 128
                and r >= 150
                and g >= 100
                and b >= 80
                and r - g >= 12
                and g - b >= 6
                and r - b >= 20
                and b * 100 >= g * 78
            ):
                out[x, y] = 255
    return mask


def detail_tone_mask(image: Image.Image, kind: str) -> Image.Image:
    rgba = image.load()
    mask = Image.new("L", image.size, 0)
    out = mask.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = rgba[x, y]
            if a < 128:
                continue
            if kind == "dark":
                selected = max(r, g, b) <= 112 and r - b <= 28
            elif kind == "orange":
                selected = r >= 128 and r >= g * 1.16 and g >= b * 1.35 and r - b >= 45
            elif kind == "hair":
                selected = (
                    35 <= r <= 150
                    and 20 <= g <= 110
                    and 10 <= b <= 90
                    and r >= g >= b
                    and (r - b) >= 18
                ) or (r >= 128 and r >= g * 1.16 and g >= b * 1.2 and r - b >= 40)
            elif kind == "white":
                selected = (
                    r >= 165
                    and g >= 165
                    and b >= 165
                    and max(r, g, b) - min(r, g, b) <= 48
                )
            else:
                raise ValueError(kind)
            if selected:
                out[x, y] = 255
    return mask


def varuint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def smooth01(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return x * x * (3.0 - 2.0 * x)


def pack_weights(ws: list[float]) -> tuple[int, int]:
    vals = [int(round(255 * w)) for w in ws]
    vals[0] += 255 - sum(vals)
    values = sum(v << (8 * i) for i, v in enumerate(vals))
    indices = sum((i + 1) << (8 * i) for i in range(len(ws)))
    return values, indices


def make_layers() -> dict:
    """Create ROUND7 crops; punch holes in head + body base. Returns box map."""
    image = Image.open(SOURCE).convert("RGBA")
    w, h = image.size
    fg = foreground_alpha(image)
    image.putalpha(ImageChops.multiply(image.getchannel("A"), fg))

    skin = skin_tone_mask(image)
    hair_c = detail_tone_mask(image, "hair")
    orange = detail_tone_mask(image, "orange")
    dark = detail_tone_mask(image, "dark")
    white = detail_tone_mask(image, "white")

    boxes: dict[str, list[int]] = {}
    masks: dict[str, Image.Image] = {}

    # --- Face ---
    eye_l = intersect(
        mask_polygon((w, h), [(400, 155), (470, 150), (485, 200), (475, 245), (410, 250), (395, 200)]),
        union(skin, white, orange, dark).filter(ImageFilter.MaxFilter(3)),
    )
    eye_r = ImageOps.mirror(eye_l)  # approximate; refine with dedicated poly
    eye_r = intersect(
        mask_polygon((w, h), [(w - x, y) for x, y in [(400, 155), (470, 150), (485, 200), (475, 245), (410, 250), (395, 200)]]),
        union(skin, white, orange, dark).filter(ImageFilter.MaxFilter(3)),
    )
    brow_l = intersect(
        mask_polygon((w, h), [(400, 140), (475, 130), (480, 160), (405, 168)]),
        dark.filter(ImageFilter.MaxFilter(3)),
    )
    brow_r = intersect(
        mask_polygon((w, h), [(w - x, y) for x, y in [(400, 140), (475, 130), (480, 160), (405, 168)]]),
        dark.filter(ImageFilter.MaxFilter(3)),
    )
    mouth = intersect(
        mask_polygon((w, h), [(460, 255), (560, 255), (555, 300), (465, 300)]),
        union(skin, dark, Image.new("L", (w, h), 0)),
    )
    # mouth: keep lips (dark/skin) inside poly — subtract large skin-only cheeks
    mouth = intersect(mouth, union(dark, skin))
    mouth = ImageChops.subtract(
        mouth,
        mask_polygon((w, h), [(460, 255), (560, 255), (560, 268), (460, 268)]),
    )  # drop upper face band if any

    # --- Hair sides / back / accessories ---
    hair_l = intersect(
        mask_polygon((w, h), [(300, 40), (430, 20), (450, 120), (440, 260), (360, 320), (290, 250), (280, 120)]),
        hair_c,
    )
    hair_r = intersect(
        mask_polygon((w, h), [(w - x, y) for x, y in [(300, 40), (430, 20), (450, 120), (440, 260), (360, 320), (290, 250), (280, 120)]]),
        hair_c,
    )
    hair_back_l = intersect(
        mask_polygon((w, h), [(280, 180), (360, 160), (380, 280), (350, 340), (290, 320)]),
        hair_c,
    )
    hair_back_r = intersect(
        mask_polygon((w, h), [(w - x, y) for x, y in [(280, 180), (360, 160), (380, 280), (350, 340), (290, 320)]]),
        hair_c,
    )
    # N+ clip on viewer-right hair
    hair_clip = intersect(
        mask_polygon((w, h), [(580, 90), (680, 80), (700, 160), (690, 200), (600, 210), (570, 150)]),
        union(white, orange, dark),
    )
    # orange bow viewer-left
    hair_bow = intersect(
        mask_polygon((w, h), [(300, 130), (400, 110), (420, 200), (390, 250), (310, 240), (290, 180)]),
        orange.filter(ImageFilter.MaxFilter(5)),
    )

    # --- Choker ---
    choker = intersect(
        mask_polygon((w, h), [(440, 310), (580, 310), (575, 355), (445, 355)]),
        union(dark, orange),
    )

    # --- Belt / pouch / id ---
    belt = intersect(
        mask_polygon((w, h), [(400, 600), (620, 600), (625, 700), (395, 700)]),
        union(dark, orange, white),
    )
    belt_buckle = intersect(
        mask_polygon((w, h), [(470, 615), (550, 615), (550, 680), (470, 680)]),
        orange.filter(ImageFilter.MaxFilter(3)),
    )
    belt_id = intersect(
        mask_polygon((w, h), [(490, 680), (545, 680), (545, 760), (490, 760)]),
        union(dark, orange, white),
    )
    belt_pouch = intersect(
        mask_polygon((w, h), [(560, 640), (640, 640), (640, 740), (560, 740)]),
        dark.filter(ImageFilter.MaxFilter(3)),
    )

    # --- Hem ribbons (hanging orange straps below jacket) ---
    hem_l = intersect(
        mask_polygon((w, h), [(320, 720), (410, 720), (400, 1000), (330, 1000)]),
        orange.filter(ImageFilter.MaxFilter(5)),
    )
    hem_r = intersect(
        mask_polygon((w, h), [(w - x, y) for x, y in [(320, 720), (410, 720), (400, 1000), (330, 1000)]]),
        orange.filter(ImageFilter.MaxFilter(5)),
    )

    # --- Legs ---
    thigh_l = intersect(
        mask_polygon((w, h), [(400, 760), (500, 755), (505, 1040), (405, 1045)]),
        skin,
    )
    thigh_r = intersect(
        mask_polygon((w, h), [(520, 755), (620, 760), (615, 1045), (515, 1040)]),
        skin,
    )
    # thigh strap on character-right thigh (= viewer left ≈ thigh_l region)
    thigh_strap = intersect(
        mask_polygon((w, h), [(400, 900), (500, 895), (500, 980), (400, 985)]),
        dark.filter(ImageFilter.MaxFilter(5)),
    )
    calf_l = union(
        intersect(
            mask_polygon((w, h), [(410, 1030), (510, 1025), (505, 1280), (415, 1285)]),
            union(skin, white),
        ),
        intersect(
            mask_polygon((w, h), [(410, 1120), (510, 1115), (505, 1285), (415, 1290)]),
            white,
        ),
    )
    calf_r = union(
        intersect(
            mask_polygon((w, h), [(515, 1025), (615, 1030), (610, 1285), (520, 1280)]),
            union(skin, white),
        ),
        intersect(
            mask_polygon((w, h), [(515, 1115), (615, 1120), (610, 1290), (520, 1285)]),
            white,
        ),
    )
    shoe_l = intersect(
        mask_polygon((w, h), [(370, 1260), (520, 1255), (530, 1500), (360, 1505)]),
        fg,
    )
    shoe_r = intersect(
        mask_polygon((w, h), [(505, 1255), (660, 1260), (670, 1505), (500, 1500)]),
        fg,
    )
    # shoes: exclude pure skin above ankle
    shoe_l = ImageChops.subtract(shoe_l, ImageChops.multiply(skin, mask_polygon((w, h), [(400, 1260), (510, 1260), (510, 1320), (400, 1320)])))
    shoe_r = ImageChops.subtract(shoe_r, ImageChops.multiply(skin, mask_polygon((w, h), [(515, 1260), (625, 1260), (625, 1320), (515, 1320)])))

    # Soften mattes slightly
    for key, m in [
        ("eye-l", eye_l), ("eye-r", eye_r), ("brow-l", brow_l), ("brow-r", brow_r),
        ("mouth", mouth), ("hair-l", hair_l), ("hair-r", hair_r),
        ("hair-back-l", hair_back_l), ("hair-back-r", hair_back_r),
        ("hair-clip", hair_clip), ("hair-bow", hair_bow), ("choker", choker),
        ("belt", belt), ("belt-buckle", belt_buckle), ("belt-id", belt_id),
        ("belt-pouch", belt_pouch), ("hem-ribbon-l", hem_l), ("hem-ribbon-r", hem_r),
        ("thigh-l", thigh_l), ("thigh-r", thigh_r), ("thigh-strap", thigh_strap),
        ("calf-sock-l", calf_l), ("calf-sock-r", calf_r),
        ("shoe-l", shoe_l), ("shoe-r", shoe_r),
    ]:
        masks[key] = m.filter(ImageFilter.MaxFilter(3))

    boxes.update({
        "eye-l": [390, 145, 495, 260],
        "eye-r": [530, 145, 635, 260],
        "brow-l": [395, 125, 490, 175],
        "brow-r": [535, 125, 630, 175],
        "mouth": [450, 250, 575, 310],
        "hair-l": [275, 15, 460, 340],
        "hair-r": [565, 15, 750, 340],
        "hair-back-l": [270, 150, 390, 350],
        "hair-back-r": [635, 150, 755, 350],
        "hair-clip": [565, 75, 710, 220],
        "hair-bow": [285, 105, 430, 260],
        "choker": [435, 305, 585, 360],
        "belt": [395, 595, 630, 710],
        "belt-buckle": [465, 610, 555, 685],
        "belt-id": [485, 675, 550, 765],
        "belt-pouch": [555, 635, 645, 745],
        "hem-ribbon-l": [315, 710, 415, 1010],
        "hem-ribbon-r": [610, 710, 710, 1010],
        "thigh-l": [395, 750, 515, 1055],
        "thigh-r": [510, 750, 630, 1055],
        "thigh-strap": [395, 890, 510, 990],
        "calf-sock-l": [405, 1020, 520, 1295],
        "calf-sock-r": [505, 1020, 625, 1295],
        "shoe-l": [355, 1250, 540, 1510],
        "shoe-r": [490, 1250, 680, 1510],
    })

    for name, box in boxes.items():
        save_crop(image, masks[name], box, OUT / f"{name}.png")

    # Punch new head layers out of head.png
    head_path = OUT / "head.png"
    head_box = [250, 0, 780, 370]
    head_im = Image.open(head_path).convert("RGBA")
    # masks are full-canvas; crop to head box then subtract
    punch = Image.new("L", (head_box[2] - head_box[0], head_box[3] - head_box[1]), 0)
    for key in ("eye-l", "eye-r", "brow-l", "brow-r", "mouth", "hair-l", "hair-r",
                "hair-back-l", "hair-back-r", "hair-clip", "hair-bow", "choker"):
        local = masks[key].crop(tuple(head_box))
        # erode slightly less than crop so soft overlap remains at seams
        core = local.point(lambda p: 255 if p >= 128 else 0)
        for _ in range(1):
            core = core.filter(ImageFilter.MinFilter(5))
        punch = ImageChops.lighter(punch, core)
    ha = ImageChops.subtract(head_im.getchannel("A"), punch)
    head_im.putalpha(ha)
    head_im.save(head_path)

    # Punch body layers out of fullbody-base
    base_path = OUT / "fullbody-base-no-head-arms.png"
    base = Image.open(base_path).convert("RGBA")
    punch_b = Image.new("L", (w, h), 0)
    for key in ("belt", "belt-buckle", "belt-id", "belt-pouch", "hem-ribbon-l", "hem-ribbon-r",
                "thigh-l", "thigh-r", "thigh-strap", "calf-sock-l", "calf-sock-r",
                "shoe-l", "shoe-r"):
        core = masks[key].point(lambda p: 255 if p >= 128 else 0)
        for _ in range(1):
            core = core.filter(ImageFilter.MinFilter(5))
        punch_b = ImageChops.lighter(punch_b, core)
    ba = ImageChops.subtract(base.getchannel("A"), punch_b)
    base.putalpha(ba)
    base.save(base_path)

    # Soft underlap: also export coat shoulder dark/orange as-is (already exist)

    # Update meta boxes
    meta = json.loads(META.read_text()) if META.exists() else {"boxes": {}}
    meta.setdefault("boxes", {}).update(boxes)
    META.write_text(json.dumps(meta, indent=2) + "\n")
    return boxes


def next_ids(n: int, start: int | None = None):
    global ID_START
    if start is not None:
        ID_START = start
    ids = list(range(ID_START, ID_START + n))
    ID_START += n
    return ids


def art_box(box: list[int]) -> tuple[float, float, float, float]:
    x0, y0 = src_to_art(box[0], box[1])
    x1, y1 = src_to_art(box[2], box[3])
    return x0, y0, x1, y1


def img_local(box: list[int], bone_xy: tuple[float, float]) -> tuple[float, float]:
    ax, ay, _, _ = art_box(box)
    return ax - bone_xy[0], ay - bone_xy[1]


def make_chain_mesh(
    name: str,
    width: int,
    height: int,
    img_xy: tuple[float, float],
    bones: list[tuple[str, float, float, float]],
    # (boneId, bx, by, along_axis_angle) in parent space where Image lives at img_xy scale SCALE
    blend_ys: list[float],
    # parent-space y thresholds for weight splits (len = n_bones-1)
    mesh_id: str,
    skin_id: str,
    scale: float = SCALE,
) -> str:
    """Simple vertical-chain mesh: weights blend along +Y in parent space."""
    ix, iy = img_xy
    cols = max(3, int(round(width * scale / GRID)) + 1)
    rows = max(3, int(round(height * scale / GRID)) + 1)
    verts = []
    for r in range(rows):
        for c in range(cols):
            u = c / (cols - 1)
            v = r / (rows - 1)
            lx = width * u
            ly = height * v
            rx = ix + lx * scale
            ry = iy + ly * scale
            verts.append((lx, ly, u, v, rx, ry))

    def weight_at(rx: float, ry: float) -> tuple[int, int]:
        n = len(bones)
        if n == 1:
            return 255, 1
        # progressive softsteps across blend_ys
        ws = [1.0] + [0.0] * (n - 1)
        rem = 1.0
        for i, thr in enumerate(blend_ys):
            t = smooth01((ry - (thr - 25)) / 50.0)
            # move rem*t from bone i to later
            take = rem * t
            ws[i] = rem - take
            rem = take
        ws[-1] = rem
        s = sum(ws) or 1.0
        ws = [w / s for w in ws]
        return pack_weights(ws)

    bset = {r * cols + c for r in range(rows) for c in range(cols) if r in (0, rows - 1) or c in (0, cols - 1)}
    order = sorted(bset) + [i for i in range(len(verts)) if i not in bset]
    newi = {o: n for n, o in enumerate(order)}
    tri = bytearray()
    for r in range(rows - 1):
        for c in range(cols - 1):
            p0 = r * cols + c
            p1, p2, p3 = p0 + 1, p0 + cols + 1, p0 + cols
            for t3 in ((p0, p1, p2), (p0, p2, p3)):
                for v in t3:
                    tri += varuint(newi[v])

    parts = [
        f'<Mesh triangleIndexBytes="{base64.b64encode(bytes(tri)).decode()}" '
        f'name="{name}.mesh" id="{mesh_id}">'
    ]
    for i in order:
        lx, ly, u, v, rx, ry = verts[i]
        vals, inds = weight_at(rx, ry)
        kind = "ContourMeshVertex" if i in bset else "MeshVertex"
        parts.append(
            f'<{kind} x="{lx:.4f}" y="{ly:.4f}" u="{u:.6f}" v="{v:.6f}" '
            f'name="{name}.v{newi[i]}"><Weight values="{vals}" indices="{inds}"/>'
            f"</{kind}>"
        )
    parts.append(f'<Skin name="{name}.skin" id="{skin_id}" xx="1" xy="0" yx="0" yy="1" tx="0" ty="0">')
    for bi, (bone_id, bx, by, ang) in enumerate(bones):
        c, s = math.cos(ang), math.sin(ang)
        parts.append(
            f'<Tendon boneId="{bone_id}" xx="{c:.6f}" xy="{s:.6f}" '
            f'yx="{-s:.6f}" yy="{c:.6f}" tx="{bx:.4f}" ty="{by:.4f}" '
            f'name="{name}.t{bi}"/>'
        )
    parts.append("</Skin></Mesh>")
    return "".join(parts)


def patch_scene(boxes: dict) -> dict:
    """Inject ImageAssets + Images + new bones + selective meshes. Returns counts."""
    scene = SCENE.read_text(encoding="utf-8")
    if 'name="full.eye.l.image"' in scene:
        print("scene already has ROUND7 eye image — re-entry safe strip not implemented; abort if partial")
        # allow re-run by skipping if marker present
        if 'ROUND7-FULL-DECOMPOSE' in scene:
            print("already patched")
            return {"skipped": True}

    counts = {"assets": 0, "images": 0, "bones": 0, "meshes": 0}

    # Spec: (file_stem, asset_name, image_name, parent_bone_name, bone_artboard_xy or None to compute from existing)
    # Parent bone world positions (artboard) from scene:
    bone_pos = {
        "full.head": (480.0, 253.9),
        "full.eye.l": (480.0 - 55, 253.9 - 140),
        "full.eye.r": (480.0 + 55, 253.9 - 140),
        "full.brow.l": (480.0 - 55, 253.9 - 177),
        "full.brow.r": (480.0 + 55, 253.9 - 177),
        "full.mouth": (480.0, 253.9 - 93),
        "full.hair.l": (480.0 - 145, 253.9 - 120),
        "full.hair.r": (480.0 + 145, 253.9 - 120),
        "full.hair.back.l": (480.0 - 180, 253.9 - 80),
        "full.hair.back.r": (480.0 + 180, 253.9 - 80),
        "full.leg-l.upper": (430.0, 720.0),
        "full.leg-l.lower": (430.0, 1020.0),  # upper + (0,300)
        "full.leg-l.foot": (430.0, 1320.0),   # lower + (0,300) then ankle+foot at 0
        "full.leg-r.upper": (530.0, 720.0),
        "full.leg-r.lower": (530.0, 1020.0),
        "full.leg-r.foot": (530.0, 1320.0),
        "full.coat-l": (350.0, 560.0),
        "full.coat-r": (610.0, 560.0),
        "full.torso": (480.0, 660.0),
        "full.root": (0.0, 0.0),
        "full.pelvis": (480.0, 700.0),
    }

    # New bones under parents (name, parent, x,y relative to parent)
    new_bones = [
        ("full.hair.clip", "full.head", 140.0, -100.0),
        ("full.hair.bow", "full.head", -120.0, -80.0),
        ("full.choker", "full.neck", 0.0, 40.0),
        ("full.belt", "full.pelvis", 0.0, -20.0),
        ("full.belt.buckle", "full.belt", 0.0, 0.0),
        ("full.belt.id", "full.belt", 10.0, 50.0),
        ("full.belt.pouch", "full.belt", 80.0, 20.0),
        ("full.hem.ribbon.l", "full.coat-l", 20.0, 200.0),
        ("full.hem.ribbon.r", "full.coat-r", -20.0, 200.0),
        ("full.thigh.strap", "full.leg-l.upper", 0.0, 200.0),
    ]
    # Update bone_pos for new bones
    parent_abs = dict(bone_pos)
    # neck at torso+(0,-406.1)
    parent_abs["full.neck"] = (480.0, 660.0 - 406.1)
    for name, parent, lx, ly in new_bones:
        px, py = parent_abs[parent]
        parent_abs[name] = (px + lx, py + ly)

    layer_specs = [
        # stem, parent_bone, mesh? (None | 'leg' | 'finger' | 'tail')
        ("eye-l", "full.eye.l", None),
        ("eye-r", "full.eye.r", None),
        ("brow-l", "full.brow.l", None),
        ("brow-r", "full.brow.r", None),
        ("mouth", "full.mouth", None),
        ("hair-l", "full.hair.l", None),
        ("hair-r", "full.hair.r", None),
        ("hair-back-l", "full.hair.back.l", None),
        ("hair-back-r", "full.hair.back.r", None),
        ("hair-clip", "full.hair.clip", None),
        ("hair-bow", "full.hair.bow", None),
        ("choker", "full.choker", None),
        ("belt", "full.belt", None),
        ("belt-buckle", "full.belt.buckle", None),
        ("belt-id", "full.belt.id", None),
        ("belt-pouch", "full.belt.pouch", None),
        ("hem-ribbon-l", "full.hem.ribbon.l", None),
        ("hem-ribbon-r", "full.hem.ribbon.r", None),
        ("thigh-l", "full.leg-l.upper", "leg-thigh"),
        ("thigh-r", "full.leg-r.upper", "leg-thigh"),
        ("thigh-strap", "full.thigh.strap", None),
        ("calf-sock-l", "full.leg-l.lower", "leg-calf"),
        ("calf-sock-r", "full.leg-r.lower", "leg-calf"),
        ("shoe-l", "full.leg-l.foot", "leg-foot"),
        ("shoe-r", "full.leg-r.foot", "leg-foot"),
    ]

    # Also mesh existing coat tails + fingers
    extra_mesh = [
        ("coat-l-tail", "full.coat-l", "full.coat-l.tail.image", "0:9316", "tail"),
        ("coat-r-tail", "full.coat-r", "full.coat-r.tail.image", "0:9317", "tail"),
    ]
    fingers = [
        ("l", "thumb", "0:9341", "0:9227", "0:9290", "0:9291"),
        ("l", "index", "0:9342", "0:9228", "0:9292", "0:9293"),
        ("l", "middle", "0:9343", "0:9229", "0:9294", "0:9295"),
        ("l", "ring", "0:9344", "0:9243", "0:9296", "0:9297"),
        ("l", "little", "0:9345", "0:9244", "0:9298", "0:9299"),
        ("r", "thumb", "0:9347", "0:9245", "0:9300", "0:9301"),
        ("r", "index", "0:9348", "0:9246", "0:9302", "0:9303"),
        ("r", "middle", "0:9349", "0:9247", "0:9304", "0:9305"),
        ("r", "ring", "0:9350", "0:9248", "0:9306", "0:9307"),
        ("r", "little", "0:9351", "0:9249", "0:9308", "0:9309"),
    ]
    # Verify finger bone ids from scene
    for side, fname, img_id, b0, b1, b2 in fingers:
        for bid, label in [(b0, f"arm-{side}.{fname}"), (b1, f".1"), (b2, f".2")]:
            pass  # will validate via regex below

    # --- Insert ImageAssets before ViewModel ---
    asset_xml = ['    <!-- ROUND7-FULL-DECOMPOSE assets -->\n']
    image_ids = {}
    asset_ids = {}
    for stem, parent, _mesh in layer_specs:
        aids = next_ids(2)
        asset_id, image_id = f"0:{aids[0]}", f"0:{aids[1]}"
        asset_ids[stem] = asset_id
        image_ids[stem] = image_id
        asset_xml.append(
            f'    <ImageAsset name="fullbody-{stem}" file="reference/svg-rig/{stem}.png" id="{asset_id}"/>\n'
        )
        counts["assets"] += 1
    scene = scene.replace(
        '    <ViewModel name="MascotFull"',
        "".join(asset_xml) + '    <ViewModel name="MascotFull"',
        1,
    )

    # --- Expand self-closing bones + inject new bones ---
    # Convert empty RootBones that need children
    for bone_name in [
        "full.eye.l", "full.eye.r", "full.brow.l", "full.brow.r", "full.mouth",
        "full.hair.l", "full.hair.r", "full.hair.back.l", "full.hair.back.r",
        "full.pelvis",
    ]:
        pat = re.compile(
            rf'(<RootBone name="{re.escape(bone_name)}"([^>]*)?)/>',
        )
        scene, n = pat.subn(rf'<RootBone name="{bone_name}"\2></RootBone>', scene, count=1)
        if n:
            print("expanded", bone_name)

    # Expand neck if self-closing somehow — it's not
    # Insert new bones: hair.clip/bow inside head; choker inside neck; belt inside pelvis; etc.

    def insert_inside_bone(scene: str, parent: str, child_xml: str) -> str:
        """Insert child_xml just after opening RootBone parent tag (before first child or before close)."""
        pat = re.compile(rf'(<RootBone name="{re.escape(parent)}"[^>]*>)')
        m = pat.search(scene)
        if not m:
            raise SystemExit(f"missing parent bone {parent}")
        return scene[: m.end()] + "\n" + child_xml + scene[m.end() :]

    bone_id_map = {}
    for name, parent, lx, ly in new_bones:
        bid = f"0:{next_ids(1)[0]}"
        bone_id_map[name] = bid
        child = f'                        <RootBone name="{name}" x="{lx}" y="{ly}" rotation="0" length="1" scaleX="1" id="{bid}"></RootBone>'
        scene = insert_inside_bone(scene, parent, child)
        counts["bones"] += 1
        print("added bone", name, bid)

    # Refresh parent_abs for choker: neck is parent
    # Insert Images into their parent bones
    for stem, parent, mesh_kind in layer_specs:
        box = boxes[stem]
        bw, bh = box[2] - box[0], box[3] - box[1]
        bxy = parent_abs[parent]
        ix, iy = img_local(box, bxy)
        img_name = f"full.{stem.replace('-', '.')}.image"
        # normalize names to dotted form matching existing style
        img_name = {
            "eye-l": "full.eye.l.image",
            "eye-r": "full.eye.r.image",
            "brow-l": "full.brow.l.image",
            "brow-r": "full.brow.r.image",
            "mouth": "full.mouth.image",
            "hair-l": "full.hair.l.image",
            "hair-r": "full.hair.r.image",
            "hair-back-l": "full.hair.back.l.image",
            "hair-back-r": "full.hair.back.r.image",
            "hair-clip": "full.hair.clip.image",
            "hair-bow": "full.hair.bow.image",
            "choker": "full.choker.image",
            "belt": "full.belt.image",
            "belt-buckle": "full.belt.buckle.image",
            "belt-id": "full.belt.id.image",
            "belt-pouch": "full.belt.pouch.image",
            "hem-ribbon-l": "full.hem.ribbon.l.image",
            "hem-ribbon-r": "full.hem.ribbon.r.image",
            "thigh-l": "full.thigh.l.image",
            "thigh-r": "full.thigh.r.image",
            "thigh-strap": "full.thigh.strap.image",
            "calf-sock-l": "full.calf.l.image",
            "calf-sock-r": "full.calf.r.image",
            "shoe-l": "full.shoe.l.image",
            "shoe-r": "full.shoe.r.image",
        }[stem]

        mesh_xml = ""
        if mesh_kind:
            mid, sid = next_ids(2)
            mid_s, sid_s = f"0:{mid}", f"0:{sid}"
            # Bone id lookup from scene for legs
            bone_name_for_tendon = parent
            m = re.search(rf'<RootBone name="{re.escape(parent)}"[^>]*id="([^"]+)"', scene)
            if not m:
                raise SystemExit(f"no id for {parent}")
            bone_id = m.group(1)
            # For leg segments use single-bone mesh (honest: nested length=1 chain)
            mesh_xml = make_chain_mesh(
                stem,
                bw,
                bh,
                (ix, iy),
                [(bone_id, 0.0, 0.0, 0.0)],
                [],
                mid_s,
                sid_s,
            )
            # Remount image at 0,0 scale 1 under a wrapper? Keep simple: Image stays
            # under bone with scale SCALE; mesh local coords in image px.
            # Tendon at bone origin — Image offset (ix,iy) is in bone space.
            # Rebuild mesh with tendon tx/ty = 0 and verts in image-local only,
            # Skin bind identity — for single bone rigid mesh this deforms with bone.
            counts["meshes"] += 1

        img_xml = (
            f'<Image name="{img_name}" assetId="{asset_ids[stem]}" '
            f'x="{ix:.4f}" y="{iy:.4f}" originX="0" originY="0" '
            f'scaleX="{SCALE}" scaleY="{SCALE}" id="{image_ids[stem]}">'
            f"{mesh_xml}</Image>"
        )
        scene = insert_inside_bone(scene, parent, "                        " + img_xml)
        counts["images"] += 1

    # Coat-tail meshes: inject into existing Image tags
    for stem, bone, img_name, img_id, kind in extra_mesh:
        m = re.search(
            rf'(<Image name="{re.escape(img_name)}"[^>]*?)(?:/>|></Image>)',
            scene,
        )
        if not m:
            print("warn: missing", img_name)
            continue
        # get asset path size
        png = OUT / f"{stem}.png"
        im = Image.open(png)
        bw, bh = im.size
        # parse x,y from open tag
        open_tag = m.group(1)
        xm = re.search(r'\bx="([^"]+)"', open_tag)
        ym = re.search(r'\by="([^"]+)"', open_tag)
        ix, iy = float(xm.group(1)), float(ym.group(1))
        bm = re.search(rf'<RootBone name="{re.escape(bone)}"[^>]*id="([^"]+)"', scene)
        bone_id = bm.group(1)
        mid, sid = next_ids(2)
        mesh_xml = make_chain_mesh(
            stem, bw, bh, (ix, iy), [(bone_id, 0.0, 0.0, 0.0)], [], f"0:{mid}", f"0:{sid}"
        )
        scene = scene[: m.start()] + open_tag + ">" + mesh_xml + "</Image>" + scene[m.end() :]
        counts["meshes"] += 1

    # Finger meshes — single-bone (finger root). Phalanx sub-crops skipped (pixels too thin).
    # Left-hand non-thumb finger Images are nested under thumb in the authored scene;
    # bind each Image to its logical finger root in the Image parent space via Tendon.
    for side in ("l", "r"):
        for fname in ("thumb", "index", "middle", "ring", "little"):
            img_name = f"full.hand-{side}.{fname}.image"
            m = re.search(
                rf'(<Image name="{re.escape(img_name)}"[^>]*?)(?:/>|>(.*?)</Image>)',
                scene,
                re.S,
            )
            if not m:
                print("warn missing finger image", img_name)
                continue
            open_tag = m.group(1)
            if "<Mesh" in m.group(0):
                continue
            xm = re.search(r'\bx="([^"]+)"', open_tag)
            ym = re.search(r'\by="([^"]+)"', open_tag)
            ix, iy = float(xm.group(1)), float(ym.group(1))
            png = OUT / f"hand-{side}-{fname}.png"
            bw, bh = Image.open(png).size
            bname = f"full.arm-{side}.{fname}"
            bm = re.search(rf'<RootBone name="{re.escape(bname)}"[^>]*id="([^"]+)"', scene)
            if not bm:
                print("warn missing bone", bname)
                continue
            bone_id = bm.group(1)
            mid, sid = next_ids(2)
            mesh_xml = make_chain_mesh(
                f"hand-{side}-{fname}",
                bw,
                bh,
                (ix, iy),
                [(bone_id, 0.0, 0.0, 0.0)],
                [],
                f"0:{mid}",
                f"0:{sid}",
            )
            scene = scene[: m.start()] + open_tag + ">" + mesh_xml + "</Image>" + scene[m.end() :]
            counts["meshes"] += 1

    # Wire coat shoulder dark overlays as static (assets already exist)
    for side, asset_id, x, y in [
        ("l", "0:9400", 279.4141, 241.2109),
        ("r", "0:9406", 524.0104, 241.2109),
    ]:
        iid = f"0:{next_ids(1)[0]}"
        name = f"full.arm-{side}.coat-shoulder.dark.static"
        if name in scene:
            continue
        xml = (
            f'                <Image name="{name}" assetId="{asset_id}" '
            f'x="{x}" y="{y}" originX="0" originY="0" '
            f'scaleX="{SCALE}" scaleY="{SCALE}" id="{iid}"/>\n'
        )
        # insert after coat-shoulder.static
        anchor = f'full.arm-{side}.coat-shoulder.static'
        am = re.search(rf'<Image name="{re.escape(anchor)}"[^/]*/>', scene)
        if am:
            scene = scene[: am.end()] + "\n" + xml + scene[am.end() :]
            counts["images"] += 1

    # Marker comment
    if "ROUND7-FULL-DECOMPOSE" not in scene:
        scene = scene.replace(
            "<Rive version=\"1\" kind=\"fragment\">",
            "<Rive version=\"1\" kind=\"fragment\">\n    <!-- ROUND7-FULL-DECOMPOSE -->",
            1,
        )

    SCENE.write_text(scene, encoding="utf-8")
    return counts


def update_license(boxes: dict) -> None:
    data = json.loads(LICENSE.read_text())
    assets = data.setdefault("assets", {})
    data["note"] = (
        "Production Rive scene uses the mother image and deterministic source-pixel "
        "rig layers. ROUND7: full decompose — face/hair/choker/belt/hem/legs crops + "
        "selective Mesh on legs/fingers/coat-tails. Finger phalanx sub-crops skipped."
    )
    for stem in boxes:
        rel = f"reference/svg-rig/{stem}.png"
        path = PROJECT / rel
        assets[rel] = {
            "sha256": sha256(path),
            "bytes": path.stat().st_size,
            "ai_generated": False,
            "in_scene": True,
            "method": "deterministic source-pixel rig layer derived from user supplied full-body mother",
        }
    # refresh punched head/base hashes
    for rel in (
        "reference/svg-rig/head.png",
        "reference/svg-rig/fullbody-base-no-head-arms.png",
    ):
        path = PROJECT / rel
        if rel in assets:
            assets[rel]["sha256"] = sha256(path)
            assets[rel]["bytes"] = path.stat().st_size
    LICENSE.write_text(json.dumps(data, indent=2) + "\n")


def main() -> None:
    print("ROUND7: cropping layers…")
    boxes = make_layers()
    print(f"  wrote {len(boxes)} crops")
    print("ROUND7: patching scene…")
    counts = patch_scene(boxes)
    print("  counts", counts)
    print("ROUND7: license…")
    update_license(boxes)
    print("done")


if __name__ == "__main__":
    main()
