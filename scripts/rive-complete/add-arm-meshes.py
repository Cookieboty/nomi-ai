#!/usr/bin/env python3
"""Migrate arm bones to independent rest-angled RootBones and inject Mesh+Skin.

Production bones were length=1 / scaleX=1 anchors with nested images. That model
cannot bind continuous sleeve meshes (parented = double-transform; identity
Tendons tear at the elbow). This script:

1. Converts upper / fore / hand to *independent* RootBones under arm.rig with
   rotation = rest limb angle (r3 pattern). scaleX stays 1 — putting link length
   into scaleX warps mother-crop rest poses (unlike r3 AI straight-sleeve art).
2. Remounts sleeve / shoulder / cuff / skin images under arm.rig (not under a
   rotating bone) and adds a grid Mesh+Skin with Tendon rotation matrices.
3. Leaves palm/finger images parented to the hand bone (rigid).

Safe to re-run. After running, apply relative clips via animate-fullbody.mjs then
bake-arm-fk-anims.py once (idempotent).
"""
from __future__ import annotations

import base64
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENE = ROOT / "rive" / "nomi-complete" / "scene.rml"
META = ROOT / "rive" / "nomi-complete" / "reference" / "svg-rig" / "rig-meta.json"
SCALE = 0.8463541666666666
OX, OY = 46.666666666666686, 0.0
GRID = 28.0  # artboard px between mesh samples (~ denser than r3's 30 art-px)

# Rest offsets (arm.rig local) — match authored scene.
ARM = {
    "l": {
        "rig": (317.8, 270.8),
        "rig_id": "0:9378",
        "upper_id": "0:9213",
        "fore_id": "0:9215",
        "hand_id": "0:9217",
        "fore_off": (-25.4, 215.5),
        "hand_off": (-17.0, 174.3),  # relative to fore
    },
    "r": {
        "rig": (642.8, 270.8),
        "rig_id": "0:9379",
        "upper_id": "0:9219",
        "fore_id": "0:9221",
        "hand_id": "0:9223",
        "fore_off": (25.4, 215.5),
        "hand_off": (17.0, 174.3),
    },
}


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
    """ws length 2 or 3, sum≈1 → packed values/indices (1-based tendon slots)."""
    n = len(ws)
    vals = [int(round(255 * w)) for w in ws]
    vals[0] += 255 - sum(vals)
    values = sum(v << (8 * i) for i, v in enumerate(vals))
    indices = sum((i + 1) << (8 * i) for i in range(n))
    return values, indices


def src_to_art(sx: float, sy: float) -> tuple[float, float]:
    return sx * SCALE + OX, sy * SCALE + OY


def extract_tag(scene: str, name: str) -> str:
    """Return the full Image open…close (or self-closing) element for name=."""
    pat = re.compile(
        rf'(<Image\b[^>]*\bname="{re.escape(name)}"[^>]*?)(?:/>|>.*?</Image>)',
        re.DOTALL,
    )
    m = pat.search(scene)
    if not m:
        raise SystemExit(f"missing image: {name}")
    return m.group(0)


def strip_mesh(img_xml: str) -> str:
    """Remove any nested Mesh from an Image element; return self-closing or empty body."""
    m = re.match(r"(<Image\b[^>]*?)(?:/>|>(.*?)</Image>)$", img_xml, re.DOTALL)
    if not m:
        raise SystemExit("bad image xml")
    open_tag = m.group(1)
    if open_tag.endswith("/"):
        open_tag = open_tag[:-1]
    # drop prior mesh; keep other children? none expected
    return open_tag.strip() + "/>"


def bone_rest(side: str) -> dict:
    a = ARM[side]
    fx, fy = a["fore_off"]
    hx, hy = a["hand_off"]
    a1 = math.atan2(fy, fx)
    a2 = math.atan2(hy, hx)
    L1 = math.hypot(fx, fy)
    L2 = math.hypot(hx, hy)
    hand_pos = (fx + hx, fy + hy)
    return {
        "a1": a1,
        "a2": a2,
        "L1": L1,
        "L2": L2,
        "upper_pos": (0.0, 0.0),
        "fore_pos": (fx, fy),
        "hand_pos": hand_pos,
        **a,
    }


def make_grid_mesh(
    name: str,
    width: int,
    height: int,
    img_xy: tuple[float, float],
    bones: list[tuple[str, float, float, float, float]],
    # bones: (boneId, angle, length, bx, by) in arm.rig space
    blend: str,
    mesh_id: str,
    skin_id: str,
) -> str:
    """Grid mesh in image-local px; Tendons in same space with rot×length bind."""
    ix, iy = img_xy
    # sample in artboard space then convert to image-local
    cols = max(3, int(round(width * SCALE / GRID)) + 1)
    rows = max(3, int(round(height * SCALE / GRID)) + 1)
    verts: list[tuple[float, float, float, float, float, float]] = []
    # (rig_x, rig_y, u, v, rig_x, rig_y) — Image at (0,0) scale 1, so local == arm.rig
    for r in range(rows):
        for c in range(cols):
            u = c / (cols - 1)
            v = r / (rows - 1)
            lx = width * u
            ly = height * v
            rx = ix + lx * SCALE
            ry = iy + ly * SCALE
            verts.append((rx, ry, u, v, rx, ry))

    def weight_at(rx: float, ry: float) -> tuple[int, int]:
        # blend along bone chain in arm.rig space
        if blend == "upper_fore":
            # tendon0=upper, tendon1=fore — smoothstep across elbow
            (_id0, a0, L0, bx0, by0) = bones[0]
            (_id1, a1, L1, bx1, by1) = bones[1]
            # signed progress from upper origin toward fore along upper axis
            # elbow blend band ±55 artboard px (≈ r3 bent)
            ex, ey = bx1, by1
            # bisector of upper and fore directions
            d0 = (math.cos(a0), math.sin(a0))
            d1 = (math.cos(a1), math.sin(a1))
            nb = (d0[0] + d1[0], d0[1] + d1[1])
            nlen = math.hypot(*nb) or 1.0
            nb = (nb[0] / nlen, nb[1] / nlen)
            u_el = (rx - ex) * nb[0] + (ry - ey) * nb[1]
            B = 55.0
            w1 = smooth01((u_el + B) / (2 * B))  # weight on fore
            w0 = 1.0 - w1
            return pack_weights([w0, w1])
        if blend == "fore_hand":
            (_id0, a0, L0, bx0, by0) = bones[0]
            (_id1, a1, L1, bx1, by1) = bones[1]
            wx, wy = bx1, by1
            d = (math.cos(a0), math.sin(a0))
            u_w = (rx - wx) * d[0] + (ry - wy) * d[1]
            w1 = smooth01((u_w + 40) / 80.0)  # hand takes cuff/near-wrist
            w0 = 1.0 - w1
            return pack_weights([w0, w1])
        if blend == "upper_only":
            return 255, 1
        raise SystemExit(f"unknown blend {blend}")

    bset = {
        r * cols + c
        for r in range(rows)
        for c in range(cols)
        if r in (0, rows - 1) or c in (0, cols - 1)
    }
    order = sorted(bset) + [i for i in range(len(verts)) if i not in bset]
    newi = {o: n for n, o in enumerate(order)}
    tri = bytearray()
    for r in range(rows - 1):
        for c in range(cols - 1):
            p0 = r * cols + c
            p1 = p0 + 1
            p2 = p0 + cols + 1
            p3 = p0 + cols
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
    for bi, (bone_id, ang, length, bx, by) in enumerate(bones):
        # Everything in arm.rig space (Image at 0,0 scale 1).
        tx, ty = bx, by
        # Rotation-only bind (scaleX=1 on bones). Joint spacing comes from keyed x/y.
        # Length value is kept for FK baking tip placement, not bone.scaleX.
        sig = 1.0
        c, s = math.cos(ang), math.sin(ang)
        # r3: xx=c*sig, xy=s*sig, yx=-s*sw, yy=c*sw
        sw = 1.0
        parts.append(
            f'<Tendon boneId="{bone_id}" xx="{c * sig:.6f}" xy="{s * sig:.6f}" '
            f'yx="{-s * sw:.6f}" yy="{c * sw:.6f}" tx="{tx:.4f}" ty="{ty:.4f}" '
            f'name="{name}.t{bi}"/>'
        )
    parts.append("</Skin></Mesh>")
    return "".join(parts)


# Image specs: (image_name, box_key, side, blend, mesh_id, skin_id, asset stays)
# blend upper_fore uses upper+fore; fore_hand uses fore+hand; upper_only = shoulder cap
MESH_IDS_START = 9700


def image_specs(meta_boxes: dict) -> list[dict]:
    specs = []
    mid = MESH_IDS_START
    layers = [
        ("full.sleeve-l.upper.image", "sleeve-l-upper", "l", "upper_fore"),
        ("full.sleeve-l.upper.dark.image", "sleeve-l-upper-dark", "l", "upper_fore"),
        ("full.sleeve-l.upper.orange.image", "sleeve-l-upper-orange", "l", "upper_fore"),
        ("full.sleeve-l.lower.image", "sleeve-l-lower", "l", "fore_hand"),
        ("full.sleeve-l.lower.dark.image", "sleeve-l-lower-dark", "l", "fore_hand"),
        ("full.sleeve-l.lower.orange.image", "sleeve-l-lower-orange", "l", "fore_hand"),
        ("full.arm-l.cuff.image", "arm-l-cuff", "l", "fore_hand"),
        ("full.arm-l.coat-shoulder.image", "coat-l-shoulder", "l", "upper_fore"),
        ("full.arm-l.upper-skin.image", "arm-l-upper-skin", "l", "upper_only"),
        ("full.sleeve-r.upper.image", "sleeve-r-upper", "r", "upper_fore"),
        ("full.sleeve-r.upper.dark.image", "sleeve-r-upper-dark", "r", "upper_fore"),
        ("full.sleeve-r.upper.orange.image", "sleeve-r-upper-orange", "r", "upper_fore"),
        ("full.sleeve-r.lower.image", "sleeve-r-lower", "r", "fore_hand"),
        ("full.sleeve-r.lower.dark.image", "sleeve-r-lower-dark", "r", "fore_hand"),
        ("full.sleeve-r.lower.orange.image", "sleeve-r-lower-orange", "r", "fore_hand"),
        ("full.arm-r.cuff.image", "arm-r-cuff", "r", "fore_hand"),
        ("full.arm-r.coat-shoulder.image", "coat-r-shoulder", "r", "upper_fore"),
        ("full.arm-r.upper-skin.image", "arm-r-upper-skin", "r", "upper_only"),
    ]
    for img_name, box_key, side, blend in layers:
        x0, y0, x1, y1 = meta_boxes[box_key]
        w, h = x1 - x0, y1 - y0
        ax, ay = src_to_art(x0, y0)
        rx, ry = ARM[side]["rig"]
        ix, iy = ax - rx, ay - ry
        specs.append(
            {
                "name": img_name,
                "side": side,
                "blend": blend,
                "w": w,
                "h": h,
                "ix": ix,
                "iy": iy,
                "mesh_id": f"0:{mid}",
                "skin_id": f"0:{mid + 1}",
            }
        )
        mid += 2
    return specs


def extract_hand_subtree(scene: str, side: str) -> str:
    """Extract the hand RootBone block (including fingers/images) for one side."""
    name = f"full.arm-{side}.hand"
    # find opening RootBone for hand
    start = scene.find(f'<RootBone name="{name}"')
    if start < 0:
        raise SystemExit(f"hand bone not found: {name}")
    # walk to matching close — nested RootBones
    i = start
    depth = 0
    while i < len(scene):
        open_m = re.match(r"<RootBone\b[^>]*>", scene[i:])
        self_m = re.match(r"<RootBone\b[^>]*/>", scene[i:])
        if self_m and (not open_m or self_m.end() <= (open_m.end() if open_m else 999)):
            if depth == 0:
                return scene[start : start + self_m.end()]
            i += self_m.end()
            continue
        if open_m and scene[i:].startswith("<RootBone"):
            # could be open or self — check
            tag_end = scene.find(">", i)
            tag = scene[i : tag_end + 1]
            if tag.endswith("/>"):
                if depth == 0:
                    return scene[start : tag_end + 1]
                i = tag_end + 1
                continue
            depth += 1
            i = tag_end + 1
            continue
        if scene.startswith("</RootBone>", i):
            depth -= 1
            i += len("</RootBone>")
            if depth == 0:
                return scene[start:i]
            continue
        i += 1
    raise SystemExit(f"unclosed hand bone: {name}")


def rebuild_arm_rig(scene: str, side: str, skinned_images: list[str], hand_xml: str) -> str:
    """Replace arm-{side}.rig … matching close with length-encoded independent bones."""
    rest = bone_rest(side)
    a = ARM[side]
    fx, fy = a["fore_off"]
    hx, hy = a["hand_off"]
    a1, a2 = rest["a1"], rest["a2"]
    L1, L2 = rest["L1"], rest["L2"]
    hand_x, hand_y = fx + hx, fy + hy

    # Rewrite hand opening tag to sit at absolute arm.rig position with rest angle
    hand_xml2 = re.sub(
        rf'<RootBone name="full\.arm-{side}\.hand"[^>]*>',
        f'<RootBone name="full.arm-{side}.hand" x="{hand_x:.4f}" y="{hand_y:.4f}" '
        f'rotation="0" length="1" scaleX="1" id="{a["hand_id"]}">',
        hand_xml,
        count=1,
    )

    skinned_block = "\n".join(skinned_images)

    new_rig = f'''<RootBone name="full.arm-{side}.rig" x="{a["rig"][0]}" y="{a["rig"][1]}" rotation="0" length="1" scaleX="1" id="{a["rig_id"]}">
                    <RootBone name="full.arm-{side}.upper" x="0" y="0" rotation="{a1:.6f}" length="1" scaleX="1" id="{a["upper_id"]}"/>
                    <RootBone name="full.arm-{side}.fore" x="{fx}" y="{fy}" rotation="{a2:.6f}" length="1" scaleX="1" id="{a["fore_id"]}"/>
                    {hand_xml2}
{skinned_block}
                </RootBone>'''

    # Find and replace old arm.rig block
    rig_name = f"full.arm-{side}.rig"
    start = scene.find(f'<RootBone name="{rig_name}"')
    if start < 0:
        raise SystemExit(f"missing {rig_name}")
    i = start
    depth = 0
    while i < len(scene):
        if scene.startswith("<RootBone", i):
            tag_end = scene.find(">", i)
            tag = scene[i : tag_end + 1]
            if tag.endswith("/>"):
                if depth == 0:
                    end = tag_end + 1
                    break
                i = tag_end + 1
                continue
            depth += 1
            i = tag_end + 1
            continue
        if scene.startswith("</RootBone>", i):
            depth -= 1
            i += len("</RootBone>")
            if depth == 0:
                end = i
                break
            continue
        i += 1
    else:
        raise SystemExit(f"unclosed {rig_name}")

    # Old structure had an extra closing </RootBone> for nested upper — our new
    # block is self-contained. Also absorb a trailing orphan </RootBone> if the
    # previous wrap left a double-close pattern right after.
    after = scene[end : end + 40]
    # keep end as-is; caller may clean orphan closes

    return scene[:start] + new_rig + scene[end:]


def build_skinned_image(scene: str, spec: dict, rest: dict) -> str:
    raw = extract_tag(scene, spec["name"])
    # pull assetId and id from existing
    am = re.search(r'assetId="([^"]+)"', raw)
    imid = re.search(r'\bid="([^"]+)"', raw)
    asset_id = am.group(1) if am else ""
    image_id = imid.group(1) if imid else ""
    side = spec["side"]
    a = ARM[side]
    if spec["blend"] == "upper_fore":
        bones = [
            (a["upper_id"], rest["a1"], rest["L1"], 0.0, 0.0),
            (a["fore_id"], rest["a2"], rest["L2"], rest["fore_pos"][0], rest["fore_pos"][1]),
        ]
    elif spec["blend"] == "fore_hand":
        bones = [
            (a["fore_id"], rest["a2"], rest["L2"], rest["fore_pos"][0], rest["fore_pos"][1]),
            # Hand bone rest rotation stays 0 (images authored for rot=0).
            (a["hand_id"], 0.0, 1.0, rest["hand_pos"][0], rest["hand_pos"][1]),
        ]
    else:  # upper_only
        bones = [
            (a["upper_id"], rest["a1"], rest["L1"], 0.0, 0.0),
        ]

    mesh = make_grid_mesh(
        spec["name"].replace("full.", "").replace(".image", "").replace(".", "-"),
        spec["w"],
        spec["h"],
        (spec["ix"], spec["iy"]),
        bones,
        spec["blend"],
        spec["mesh_id"],
        spec["skin_id"],
    )
    # Image at origin with scale 1; mesh vertices carry artboard placement (r3 style).
    return (
        f'<Image name="{spec["name"]}" assetId="{asset_id}" '
        f'x="0" y="0" originX="0" originY="0" '
        f'scaleX="1" scaleY="1" id="{image_id}">{mesh}</Image>'
    )


def clean_orphan_closes(scene: str) -> str:
    """Remove accidental double </RootBone> left after arm rebuild near torso."""
    # Pattern: </RootBone>\\n                </RootBone>\\n                <RootBone name="full.pelvis"
    scene = re.sub(
        r"</RootBone>\s*</RootBone>(\s*<RootBone name=\"full\.pelvis\")",
        r"</RootBone>\1",
        scene,
    )
    # between arms
    scene = re.sub(
        r"(</RootBone>)\s*</RootBone>(\s*<RootBone name=\"full\.arm-r\.rig\")",
        r"\1\2",
        scene,
    )
    return scene


def main() -> None:
    meta = json.loads(META.read_text())
    boxes = meta["boxes"]
    scene = SCENE.read_text(encoding="utf-8")

    # Extract hand subtrees BEFORE mutating arms
    hand_l = extract_hand_subtree(scene, "l")
    hand_r = extract_hand_subtree(scene, "r")

    specs = image_specs(boxes)
    by_side = {"l": [], "r": []}
    for spec in specs:
        rest = bone_rest(spec["side"])
        by_side[spec["side"]].append(build_skinned_image(scene, spec, rest))

    scene = rebuild_arm_rig(scene, "l", by_side["l"], hand_l)
    scene = rebuild_arm_rig(scene, "r", by_side["r"], hand_r)
    scene = clean_orphan_closes(scene)

    SCENE.write_text(scene, encoding="utf-8")
    print(
        f"meshes={scene.count('<Mesh ')} tendons={scene.count('<Tendon ')} "
        f"skins={scene.count('<Skin ')}"
    )
    # write rest pose params for the FK baker
    out = {
        side: {
            "a1": bone_rest(side)["a1"],
            "a2": bone_rest(side)["a2"],
            "L1": bone_rest(side)["L1"],
            "L2": bone_rest(side)["L2"],
            "fore": list(ARM[side]["fore_off"]),
            "hand_rel": list(ARM[side]["hand_off"]),
            "ids": {
                "rig": ARM[side]["rig_id"],
                "upper": ARM[side]["upper_id"],
                "fore": ARM[side]["fore_id"],
                "hand": ARM[side]["hand_id"],
            },
        }
        for side in ("l", "r")
    }
    Path("/workspace/scratch/rive-bone-rig/v2/arm-rest.json").write_text(
        json.dumps(out, indent=2) + "\n"
    )
    print("wrote arm-rest.json")


if __name__ == "__main__":
    main()
