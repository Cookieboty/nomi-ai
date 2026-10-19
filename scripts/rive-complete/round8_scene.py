#!/usr/bin/env python3
"""ROUND8 stage 2 — rewire scene.rml (vest/shorts layers, continuous leg skin, finger chain meshes).

Run: python3 scripts/rive-complete/round8_layers.py && python3 scripts/rive-complete/round8_scene.py
Input scene is pinned to the ROUND7 commit so the script is idempotent.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

import round8_layers as L

ROOT = L.ROOT
PROJECT = L.PROJECT
OUT = L.OUT
SCENE = PROJECT / "scene.rml"
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
S = 0.8463541666666666
OX, OY = 46.666666666666686, 0.0

_next = {"asset": 10100, "image": 10200, "mesh": 10300, "bone": 10400, "anim": 10500}


def nid(kind: str) -> str:
    _next[kind] += 1
    return f"0:{_next[kind] - 1}"


def art(sx: float, sy: float) -> tuple[float, float]:
    return sx * S + OX, sy * S + OY


# ------------------------------------------------------------------ xml helpers
def find_elem(s: str, tag: str, name: str) -> tuple[int, int]:
    m = re.search(rf'<{tag}\b[^>]*\bname="{re.escape(name)}"[^>]*>', s)
    if not m:
        raise SystemExit(f"missing <{tag} name={name}>")
    if m.group(0).endswith("/>"):
        return m.start(), m.end()
    depth = 1
    pat = re.compile(rf"<{tag}\b[^>]*>|</{tag}>")
    pos = m.end()
    while depth:
        n = pat.search(s, pos)
        if not n:
            raise SystemExit(f"unterminated <{tag} name={name}>")
        t = n.group(0)
        if t.startswith("</"):
            depth -= 1
        elif not t.endswith("/>"):
            depth += 1
        pos = n.end()
    return m.start(), pos


def replace_elem(s: str, tag: str, name: str, new: str) -> str:
    a, b = find_elem(s, tag, name)
    return s[:a] + new + s[b:]


def remove_elem(s: str, tag: str, name: str) -> str:
    return replace_elem(s, tag, name, "")


def insert_before_close(s: str, tag: str, name: str, xml: str) -> str:
    a, b = find_elem(s, tag, name)
    close = s.rfind(f"</{tag}>", a, b)
    return s[:close] + xml + "\n" + s[close:]


def insert_before(s: str, tag: str, name: str, xml: str) -> str:
    a, _ = find_elem(s, tag, name)
    return s[:a] + xml + "\n" + s[a:]


def insert_after(s: str, tag: str, name: str, xml: str) -> str:
    _, b = find_elem(s, tag, name)
    return s[:b] + "\n" + xml + s[b:]


def bone(name: str, x: float, y: float, bid: str, inner: str = "", rot: float = 0.0) -> str:
    return (
        f'<RootBone name="{name}" x="{x:.4f}" y="{y:.4f}" rotation="{rot}" length="1" scaleX="1" id="{bid}">'
        f"{inner}</RootBone>"
    )


def image_rigid(name: str, asset: str, box: list[int], parent_abs: tuple[float, float], extra: str = "") -> str:
    ax, ay = art(box[0], box[1])
    return (
        f'<Image name="{name}" assetId="{asset}" x="{ax - parent_abs[0]:.4f}" y="{ay - parent_abs[1]:.4f}" '
        f'originX="0" originY="0" scaleX="{S}" scaleY="{S}" id="{nid("image")}">{extra}</Image>'
    )


# ------------------------------------------------------------------ mesh builders
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
    ws = [max(0.0, w) for w in ws]
    t = sum(ws) or 1.0
    ws = [w / t for w in ws]
    vals = [int(round(255 * w)) for w in ws]
    vals[int(np.argmax(vals))] += 255 - sum(vals)
    return sum(v << (8 * i) for i, v in enumerate(vals)), sum((i + 1) << (8 * i) for i in range(len(ws)))


def grid_mesh(
    name: str,
    img_xy: tuple[float, float],  # image top-left in the Image-parent space
    size_px: tuple[int, int],     # png size
    cell: tuple[float, float],    # target cell (w,h) in parent-space px
    weight_fn,                    # (x,y in parent space) -> list[float]
    bones: list[tuple[str, tuple[float, float]]],  # (bone id, rest origin in parent space), rest rotation 0
    row_edges: list[float] | None = None,
) -> str:
    w, h = size_px
    ix, iy = img_xy
    cols = max(2, int(round(w * S / cell[0])) + 1)
    if row_edges is None:
        rows = max(2, int(round(h * S / cell[1])) + 1)
        vs = [r / (rows - 1) for r in range(rows)]
    else:
        vs = row_edges
        rows = len(vs)
    verts = []
    for r in range(rows):
        for c in range(cols):
            u = c / (cols - 1)
            v = vs[r]
            verts.append((ix + w * u * S, iy + h * v * S, u, v))
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
    parts = [f'<Mesh triangleIndexBytes="{base64.b64encode(bytes(tri)).decode()}" name="{name}.mesh" id="{nid("mesh")}">']
    for i in order:
        x, y, u, v = verts[i]
        vals, inds = pack_weights(weight_fn(x, y))
        kind = "ContourMeshVertex" if i in bset else "MeshVertex"
        parts.append(
            f'<{kind} x="{x:.4f}" y="{y:.4f}" u="{u:.6f}" v="{v:.6f}" name="{name}.v{newi[i]}">'
            f'<Weight values="{vals}" indices="{inds}"/></{kind}>'
        )
    parts.append(f'<Skin name="{name}.skin" id="{nid("mesh")}" xx="1" xy="0" yx="0" yy="1" tx="0" ty="0">')
    for k, (bid, (bx, by)) in enumerate(bones):
        parts.append(
            f'<Tendon boneId="{bid}" xx="1.000000" xy="0.000000" yx="0.000000" yy="1.000000" '
            f'tx="{bx:.4f}" ty="{by:.4f}" name="{name}.t{k}"/>'
        )
    parts.append("</Skin></Mesh>")
    return "".join(parts)


def image_mesh(name: str, asset: str, box: list[int], cell, weight_fn, bones, parent_origin=(0.0, 0.0), row_edges=None) -> str:
    ax, ay = art(box[0], box[1])
    ix, iy = ax - parent_origin[0], ay - parent_origin[1]
    w, h = box[2] - box[0], box[3] - box[1]
    mesh = grid_mesh(name, (ix, iy), (w, h), cell, weight_fn, bones, row_edges)
    return (
        f'<Image name="{name}" assetId="{asset}" x="0" y="0" originX="0" originY="0" '
        f'scaleX="1" scaleY="1" id="{nid("image")}">{mesh}</Image>'
    )


# ------------------------------------------------------------------ animation helpers
EASE = '<CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/>'


def keyed(obj_id: str, prop: str, frames: list[tuple[int, float]]) -> str:
    kf = "".join(
        f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="cubic">{EASE}</KeyFrameDouble>'
        for f, v in frames
    )
    return f'<KeyedObject objectId="{obj_id}"><KeyedProperty property="{prop}">{kf}</KeyedProperty></KeyedObject>'


def add_keys(scene: str, anim: str, xml: str) -> str:
    a, b = find_elem(scene, "LinearAnimation", anim)
    close = scene.rfind("</LinearAnimation>", a, b)
    return scene[:close] + xml + "\n" + scene[close:]


ROOT_PIVOT = {
    "l": {"thumb": (-34, 72), "index": (-10, 96), "middle": (8, 102), "ring": (22, 98), "little": (34, 88)},
    "r": {"thumb": (34, 72), "index": (10, 96), "middle": (-8, 102), "ring": (-22, 98), "little": (-34, 88)},
}


# ------------------------------------------------------------------ main patch
def main() -> None:
    boxes = json.loads(L.META.read_text())["boxes"]
    scene = subprocess.check_output(
        ["git", "-C", str(ROOT), "show", f"{L.PIN_R7}:rive/nomi-complete/scene.rml"]
    ).decode("utf-8")
    # keep idempotent id allocation deterministic
    stats = {"images": 0, "meshes": 0, "bones": 0, "assets": 0}

    # ---- assets: drop ROUND7 mislabeled layers, add ROUND8 layers
    drop_assets = ["fullbody-belt", "fullbody-belt-buckle", "fullbody-thigh-l", "fullbody-thigh-r",
                   "fullbody-thigh-strap", "fullbody-calf-sock-l", "fullbody-calf-sock-r"]
    for nm in drop_assets:
        scene = re.sub(rf'\n\s*<ImageAsset name="{nm}"[^>]*/>', "", scene)
    asset_ids = {}
    new_assets = ""
    for stem in ("torso-tank", "belt-band", "shorts", "leg-l-skin", "leg-r-skin"):
        aid = nid("asset")
        asset_ids[stem] = aid
        new_assets += f'\n    <ImageAsset name="fullbody-{stem}" file="reference/svg-rig/{stem}.png" id="{aid}"/>'
        stats["assets"] += 1
    scene = insert_after(scene, "ImageAsset", "fullbody-shoe-r", new_assets.lstrip("\n")) if False else scene
    m = re.search(r'<ImageAsset name="fullbody-shoe-r"[^>]*/>', scene)
    scene = scene[: m.end()] + new_assets + scene[m.end():]
    asset_of = {
        "belt-id": "0:9928", "belt-pouch": "0:9930", "shoe-l": "0:9946", "shoe-r": "0:9948",
        **asset_ids,
    }

    # ---- torso tank (child of torso, drawn behind head/neck, in front of static collar/underlay)
    torso_abs = (480.0, 660.0)
    tank_img = image_rigid("full.torso.tank.image", asset_of["torso-tank"], boxes["torso-tank"], torso_abs)
    scene = insert_before_close(scene, "RootBone", "full.torso", "                        " + tank_img)
    stats["images"] += 1

    # ---- pelvis: shorts + swing overlays (ID card, pouch); old ROUND7 belt* pieces removed
    pelvis_abs = (480.0, 610.0)
    id_pivot = art(458, 516)
    pouch_pivot = art(598, 516)
    id_img = image_rigid("full.belt.id.image", asset_of["belt-id"], boxes["belt-id"], id_pivot)
    pouch_img = image_rigid("full.belt.pouch.image", asset_of["belt-pouch"], boxes["belt-pouch"], pouch_pivot)
    shorts_img = image_rigid("full.shorts.image", asset_of["shorts"], boxes["shorts"], pelvis_abs)
    pelvis = bone(
        "full.pelvis", *pelvis_abs, "0:9260",
        "\n" + bone("full.belt.id", id_pivot[0] - pelvis_abs[0], id_pivot[1] - pelvis_abs[1], "0:9955", id_img) + "\n"
        + bone("full.belt.pouch", pouch_pivot[0] - pelvis_abs[0], pouch_pivot[1] - pelvis_abs[1], "0:9956", pouch_img) + "\n"
        + shorts_img + "\n",
    )
    scene = replace_elem(scene, "RootBone", "full.pelvis", pelvis)
    stats["images"] += 3

    # ---- belt band: continuous torso→pelvis Mesh (in front of shorts and tank)
    bb = boxes["belt-band"]
    y_top, y_bot = art(0, bb[1])[1], art(0, bb[3])[1]

    def w_belt(x: float, y: float) -> list[float]:
        # torso-weighted above the cut (src y 482), pelvis-weighted below src y 516
        ya, yb = art(0, 484)[1], art(0, 514)[1]
        t = smooth01((y - ya) / (yb - ya))
        return [1.0 - t, t]

    belt_mesh = image_mesh(
        "full.belt.band.image", asset_of["belt-band"], bb, (14.0, 7.0), w_belt,
        [("0:9211", torso_abs), ("0:9260", pelvis_abs)],
    )
    scene = insert_before(scene, "RootBone", "full.pelvis", "                " + belt_mesh)
    stats["images"] += 1
    stats["meshes"] += 1

    # ---- legs: continuous Mesh (hip→knee→ankle) + rigid shoe on the foot bone
    leg_cfg = {
        "l": dict(hip=(448, 780), knee=(461, 985), ankle=(458, 1255),
                  ids=dict(upper="0:9235", lower="0:9236", foot="0:9237", knee="0:9280", ankle="0:9281",
                           toe=("0:9282", "0:9283", "0:9284"))),
        "r": dict(hip=(566, 780), knee=(551, 985), ankle=(577, 1255),
                  ids=dict(upper="0:9238", lower="0:9239", foot="0:9240", knee="0:9285", ankle="0:9286",
                           toe=("0:9287", "0:9288", "0:9289"))),
    }
    leg_world = {}
    for side, cfg in leg_cfg.items():
        hip, knee, ankle = (art(*cfg[k]) for k in ("hip", "knee", "ankle"))
        ids = cfg["ids"]
        leg_world[side] = (hip, knee, ankle)
        pre = f"full.leg-{side}"
        shoe_img = image_rigid(f"full.shoe.{side}.image", asset_of[f"shoe-{side}"], boxes[f"shoe-{side}"], ankle)
        toes = "".join(
            bone(f"{pre}.toe.{t}", dx, dy, tid)
            for t, (dx, dy), tid in zip(("l", "m", "r"), ((-30, 168), (0, 176), (30, 168)), ids["toe"])
        )
        foot = bone(f"{pre}.foot", 0, 0, ids["foot"], "\n" + shoe_img + "\n" + toes)
        ankle_b = bone(f"{pre}.ankle", 0, 0, ids["ankle"], foot)
        lower = bone(f"{pre}.lower", knee[0] - hip[0], knee[1] - hip[1], ids["lower"],
                     "\n" + bone(f"{pre}.ankle", ankle[0] - knee[0], ankle[1] - knee[1], ids["ankle"], foot))
        # keep knee anchor as a sibling of lower (same rest position)
        upper = bone(f"{pre}.upper", hip[0], hip[1], ids["upper"],
                     "\n" + bone(f"{pre}.knee", knee[0] - hip[0], knee[1] - hip[1], ids["knee"]) + "\n" + lower + "\n")
        sk = boxes[f"leg-{side}-skin"]
        ky, ay = knee[1], ankle[1]
        Bk, Ba = 40.0, 22.0

        def w_leg(x: float, y: float, ky=ky, ay=ay) -> list[float]:
            wl = smooth01((y - (ky - Bk)) / (2 * Bk))
            wf = smooth01((y - (ay - Ba)) / (2 * Ba))
            return [1.0 - wl, max(0.0, wl - wf), wf]

        # denser rows around knee/ankle blend bands
        y0a, y1a = art(0, sk[1])[1], art(0, sk[3])[1]
        edges_y = []
        y = y0a
        while y < y1a:
            edges_y.append(y)
            near = abs(y - ky) < Bk + 6 or abs(y - ay) < Ba + 6
            y += 6.0 if near else 14.0
        edges_y.append(y1a)
        v_edges = [(yy - y0a) / (y1a - y0a) for yy in edges_y]
        leg_img = image_mesh(
            f"full.leg.{side}.skin.image", asset_of[f"leg-{side}-skin"], sk, (12.0, 14.0), w_leg,
            [(ids["upper"], hip), (ids["lower"], knee), (ids["foot"], ankle)], row_edges=v_edges,
        )
        scene = replace_elem(scene, "RootBone", f"{pre}.upper", upper + "\n                " + leg_img)
        stats["images"] += 2
        stats["meshes"] += 1
        stats["bones"] += 0

    # ---- fingers: chain bones + whole-finger Mesh across 3 phalanx bones
    hand_cfg = {
        "l": dict(rig=(317.8, 270.8), hand_local=(-42.4, 389.8), box=(265, 740), hand_id="0:9217",
                  roots={"thumb": "0:9243", "index": "0:9244", "middle": "0:9245", "ring": "0:9246", "little": "0:9247"},
                  p1={"thumb": "0:9290", "index": "0:9292", "middle": "0:9294", "ring": "0:9296", "little": "0:9298"},
                  p2={"thumb": "0:9291", "index": "0:9293", "middle": "0:9295", "ring": "0:9297", "little": "0:9299"}),
        "r": dict(rig=(642.8, 270.8), hand_local=(42.4, 389.8), box=(659, 740), hand_id="0:9223",
                  roots={"thumb": "0:9248", "index": "0:9249", "middle": "0:9250", "ring": "0:9251", "little": "0:9252"},
                  p1={"thumb": "0:9300", "index": "0:9302", "middle": "0:9304", "ring": "0:9306", "little": "0:9308"},
                  p2={"thumb": "0:9301", "index": "0:9303", "middle": "0:9305", "ring": "0:9307", "little": "0:9309"}),
    }
    finger_boxes = {}
    finger_joint_abs = {}
    for side, hc in hand_cfg.items():
        rig = hc["rig"]
        hand_abs = (rig[0] + hc["hand_local"][0], rig[1] + hc["hand_local"][1])
        finger_images = ""
        for fname in ("thumb", "index", "middle", "ring", "little"):
            png = L.git_png(L.PIN_R7, f"hand-{side}-{fname}.png")
            a = np.array(png)[:, :, 3] > 0
            ys, xs = np.where(a)
            ox, oy = hc["box"]
            tb = [ox + int(xs.min()) - 2, oy + int(ys.min()) - 2, ox + int(xs.max()) + 3, oy + int(ys.max()) + 3]
            crop = png.crop((tb[0] - ox, tb[1] - oy, tb[2] - ox, tb[3] - oy))
            crop.save(OUT / f"hand-{side}-{fname}.png")
            finger_boxes[f"hand-{side}-{fname}"] = tb
            asset_id = {"l": {"thumb": "0:9326", "index": "0:9327", "middle": "0:9328", "ring": "0:9329", "little": "0:9330"},
                        "r": {"thumb": "0:9335", "index": "0:9336", "middle": "0:9337", "ring": "0:9338", "little": "0:9339"}}[side][fname]
            ax0, ay0 = art(tb[0], tb[1])
            ax1, ay1 = art(tb[2], tb[3])
            length = ay1 - ay0
            cx = (ax0 + ax1) / 2
            j0 = (cx, ay0 + 0.10 * length)           # MCP (root)
            j1 = (cx, ay0 + 0.45 * length)           # PIP
            j2 = (cx, ay0 + 0.75 * length)           # DIP
            finger_joint_abs[(side, fname)] = (j0, j1, j2)
            name = f"full.arm-{side}.{fname}"
            # keep the authored root pivot (keyed wave/clap spread depends on that lever arm);
            # the phalanx bones are nested at the real PIP / DIP joints of the sliver.
            rl = ROOT_PIVOT[side][fname]
            j0 = (hand_abs[0] + rl[0], hand_abs[1] + rl[1])
            finger_joint_abs[(side, fname)] = (j0, j1, j2)
            b2 = bone(f"{name}.2", j2[0] - j1[0], j2[1] - j1[1], hc["p2"][fname])
            b1 = bone(f"{name}.1", j1[0] - j0[0], j1[1] - j0[1], hc["p1"][fname], b2)
            b0 = bone(name, rl[0], rl[1], hc["roots"][fname], b1)
            scene = replace_elem(scene, "RootBone", name, b0)
            stats["bones"] += 0
            Bw = 0.07 * length

            def w_fin(x: float, y: float, j1=j1, j2=j2, Bw=Bw) -> list[float]:
                w1 = smooth01((y - (j1[1] - Bw)) / (2 * Bw))
                w2 = smooth01((y - (j2[1] - Bw)) / (2 * Bw))
                return [1.0 - w1, max(0.0, w1 - w2), w2]

            origin = rig
            bones_ = [(hc["roots"][fname], (j0[0] - origin[0], j0[1] - origin[1])),
                      (hc["p1"][fname], (j1[0] - origin[0], j1[1] - origin[1])),
                      (hc["p2"][fname], (j2[0] - origin[0], j2[1] - origin[1]))]
            finger_images += "\n" + image_mesh(
                f"full.hand-{side}.{fname}.image", asset_id, tb, (4.0, 4.0), w_fin, bones_, parent_origin=origin,
            )
            stats["images"] += 0  # replaced one-for-one
            stats["meshes"] += 1
        # remove old finger Image remnants (inside removed blocks already) and insert new ones after hand
        scene = insert_after(scene, "RootBone", f"full.arm-{side}.hand", finger_images)

    # ---- animations
    # idle: ID card + pouch gentle swing (pivot at the belt)
    scene = add_keys(scene, "full.idle",
                     keyed("0:9955", "rotation", [(0, 0.0), (72, 0.05), (144, -0.04), (216, 0.0)])
                     + keyed("0:9956", "rotation", [(0, 0.0), (72, -0.03), (144, 0.035), (216, 0.0)]))
    # hop: knee flex (thigh out, shin in, foot flat) so the continuous leg skin is exercised
    def leg_keys(side: str, sgn: float) -> str:
        ids = leg_cfg[side]["ids"]
        up = [(0, 0.0), (9, 0.16), (18, 0.0), (33, 0.12), (45, 0.0), (72, 0.0)]
        lo = [(0, 0.0), (9, -0.34), (18, 0.0), (33, -0.26), (45, 0.0), (72, 0.0)]
        ft = [(0, 0.0), (9, 0.18), (18, 0.0), (33, 0.14), (45, 0.0), (72, 0.0)]
        mul = lambda arr: [(f, v * sgn) for f, v in arr]  # noqa: E731
        return (keyed(ids["upper"], "rotation", mul(up)) + keyed(ids["lower"], "rotation", mul(lo))
                + keyed(ids["foot"], "rotation", mul(ft)))
    scene = add_keys(scene, "full.hop", leg_keys("l", 1.0) + leg_keys("r", -1.0))
    # wave / clap: knuckle flex across the three-phalanx chains
    def finger_flex(side: str, amp: float, frames) -> str:
        out = ""
        for fname, k in (("index", 1.0), ("middle", 1.1), ("ring", 1.0), ("little", 0.9), ("thumb", 0.7)):
            hc = hand_cfg[side]
            out += keyed(hc["p1"][fname], "rotation", [(f, v * amp * k) for f, v in frames])
            out += keyed(hc["p2"][fname], "rotation", [(f, v * amp * k * 0.8) for f, v in frames])
        return out
    scene = add_keys(scene, "full.wave", finger_flex("r", 0.20, [(0, 0.0), (22, 1.0), (47, 0.2), (72, 1.0), (96, 0.0), (108, 0.0)]))
    scene = add_keys(scene, "full.clap", finger_flex("l", 0.14, [(0, 0.0), (28, 1.0), (52, 1.0), (96, 0.0)])
                     + finger_flex("r", -0.14, [(0, 0.0), (28, 1.0), (52, 1.0), (96, 0.0)]))

    scene = scene.replace("<!-- ROUND7-FULL-DECOMPOSE -->", "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND8: tank/shorts layers, continuous leg skin, finger chains -->", 1)
    SCENE.write_text(scene, encoding="utf-8")

    # ---- boxes + license
    meta = json.loads(L.META.read_text())
    meta["boxes"].update(finger_boxes)
    L.META.write_text(json.dumps(meta, indent=2) + "\n")
    for stem in ("belt", "belt-buckle", "thigh-l", "thigh-r", "thigh-strap", "calf-sock-l", "calf-sock-r"):
        p = OUT / f"{stem}.png"
        if p.exists():
            p.unlink()
        meta["boxes"].pop(stem, None)
    L.META.write_text(json.dumps(meta, indent=2) + "\n")
    data = json.loads(LICENSE.read_text())
    assets = data["assets"]
    for stem in ("belt", "belt-buckle", "thigh-l", "thigh-r", "thigh-strap", "calf-sock-l", "calf-sock-r"):
        assets.pop(f"reference/svg-rig/{stem}.png", None)
    touched = ["torso-tank", "belt-band", "shorts", "belt-id", "belt-pouch", "leg-l-skin", "leg-r-skin", "shoe-l", "shoe-r",
               "fullbody-base-no-head-arms", "coat-l-tail", "coat-r-tail", "hem-ribbon-l", "hem-ribbon-r"]
    touched += [f"hand-{s}-{f}" for s in "lr" for f in ("thumb", "index", "middle", "ring", "little")]
    for stem in touched:
        rel = f"reference/svg-rig/{stem}.png"
        p = PROJECT / rel
        assets[rel] = {
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
            "bytes": p.stat().st_size,
            "ai_generated": False,
            "in_scene": True,
            "method": "deterministic source-pixel rig layer derived from user supplied full-body mother",
        }
    data["note"] = (data.get("note", "") + " ROUND8: vest/shorts/belt-band, continuous leg skin and tight "
                    "finger crops, all cut from the mother pixels.").strip()
    LICENSE.write_text(json.dumps(data, indent=2) + "\n")
    print("ROUND8 scene patched", stats)


if __name__ == "__main__":
    main()
