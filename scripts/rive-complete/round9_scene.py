#!/usr/bin/env python3
"""ROUND9 stage 2 — scene.rml: one continuous skinned Mesh per hand + a correctly pivoted finger skeleton.

Run: python3 scripts/rive-complete/round9_layers.py && python3 scripts/rive-complete/round9_scene.py
Input scene is pinned to ROUND8 (be33278) so the script is idempotent.
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

import round8_scene as R8
import round9_layers as L9
import round9_rig as RIG

ROOT, PROJECT, OUT = L9.ROOT, L9.PROJECT, L9.OUT
SCENE = PROJECT / "scene.rml"
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
S, OX, OY = R8.S, R8.OX, R8.OY
PIN_R8 = L9.PIN_R8

HANDS = {
    "l": dict(rig=(317.8, 270.8), hand_local=(-42.4, 389.8), hand_id="0:9217", palm="full.hand-l.palm.image", asset="0:9325",
              roots={"thumb": "0:9243", "index": "0:9244", "middle": "0:9245", "ring": "0:9246", "little": "0:9247"},
              p1={"thumb": "0:9290", "index": "0:9292", "middle": "0:9294", "ring": "0:9296", "little": "0:9298"},
              p2={"thumb": "0:9291", "index": "0:9293", "middle": "0:9295", "ring": "0:9297", "little": "0:9299"},
              drop_assets=["0:9326", "0:9327", "0:9328", "0:9329", "0:9330"]),
    "r": dict(rig=(642.8, 270.8), hand_local=(42.4, 389.8), hand_id="0:9223", palm="full.hand-r.palm.image", asset="0:9334",
              roots={"thumb": "0:9248", "index": "0:9249", "middle": "0:9250", "ring": "0:9251", "little": "0:9252"},
              p1={"thumb": "0:9300", "index": "0:9302", "middle": "0:9304", "ring": "0:9306", "little": "0:9308"},
              p2={"thumb": "0:9301", "index": "0:9303", "middle": "0:9305", "ring": "0:9307", "little": "0:9309"},
              drop_assets=["0:9335", "0:9336", "0:9337", "0:9338", "0:9339"]),
}
PARTS = ("thumb", "index", "middle", "ring", "little")


def pack4(ws: list[float]) -> tuple[int, int]:
    """top-4 influences, one byte each; indices = tendon index + 1"""
    order = sorted(range(len(ws)), key=lambda i: -ws[i])[:4]
    order = [i for i in order if ws[i] > 1e-4] or [0]
    tot = sum(ws[i] for i in order)
    vals = [int(round(255 * ws[i] / tot)) for i in order]
    vals[int(np.argmax(vals))] += 255 - sum(vals)
    return (sum(v << (8 * k) for k, v in enumerate(vals)), sum((i + 1) << (8 * k) for k, i in enumerate(order)))


def grid_mesh9(name, img_xy, size_px, cell, weight_fn, bones) -> str:
    w, h = size_px
    ix, iy = img_xy
    cols = max(2, int(round(w * S / cell)) + 1)
    rows = max(2, int(round(h * S / cell)) + 1)
    verts = []
    for r in range(rows):
        for c in range(cols):
            u, v = c / (cols - 1), r / (rows - 1)
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
                    tri += R8.varuint(newi[v])
    parts = [f'<Mesh triangleIndexBytes="{base64.b64encode(bytes(tri)).decode()}" name="{name}.mesh" id="{R8.nid("mesh")}">']
    for i in order:
        x, y, u, v = verts[i]
        vals, inds = pack4(weight_fn(x, y))
        kind = "ContourMeshVertex" if i in bset else "MeshVertex"
        parts.append(f'<{kind} x="{x:.4f}" y="{y:.4f}" u="{u:.6f}" v="{v:.6f}" name="{name}.v{newi[i]}">'
                     f'<Weight values="{vals}" indices="{inds}"/></{kind}>')
    parts.append(f'<Skin name="{name}.skin" id="{R8.nid("mesh")}" xx="1" xy="0" yx="0" yy="1" tx="0" ty="0">')
    for k, bone in enumerate(bones):
        bid, (bx, by) = bone[0], bone[1]
        xx, xy, yx, yy = bone[2] if len(bone) > 2 else (1.0, 0.0, 0.0, 1.0)
        parts.append(f'<Tendon boneId="{bid}" xx="{xx:.6f}" xy="{xy:.6f}" yx="{yx:.6f}" yy="{yy:.6f}" '
                     f'tx="{bx:.4f}" ty="{by:.4f}" name="{name}.t{k}"/>')
    parts.append("</Skin></Mesh>")
    return "".join(parts)



# ------------------------------------------------------------------ wrist re-pivot
EASE_RE = re.compile(r'<KeyFrameDouble value="([^"]*)" frame="(\d+)" interpolationType="([^"]*)">(.*?)</KeyFrameDouble>', re.S)


def _bez(x1, y1, x2, y2, x):
    lo, hi = 0.0, 1.0
    for _ in range(40):
        t = (lo + hi) / 2
        bx = 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3
        if bx < x:
            lo = t
        else:
            hi = t
    t = (lo + hi) / 2
    return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3


def sample(keys, f, default):
    """keys: [(frame, value, itype, inner)] sorted"""
    if not keys:
        return default
    if f <= keys[0][0]:
        return keys[0][1]
    if f >= keys[-1][0]:
        return keys[-1][1]
    for (f0, v0, it, inner), (f1, v1, _, _) in zip(keys, keys[1:]):
        if f0 <= f <= f1:
            u = (f - f0) / (f1 - f0)
            if it == "cubic":
                m = re.search(r'x1="([^"]*)" y1="([^"]*)" x2="([^"]*)" y2="([^"]*)"', inner)
                u = _bez(*[float(g) for g in m.groups()], u) if m else u
            return v0 + (v1 - v0) * u
    return keys[-1][1]


def parse_track(block, prop):
    m = re.search(rf'<KeyedProperty property="{prop}">(.*?)</KeyedProperty>', block, re.S)
    if not m:
        return []
    return [(int(f), float(v), it, inner) for v, f, it, inner in EASE_RE.findall(m.group(1))]


def emit_track(prop, keys):
    body = "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="{it}">{inner}</KeyFrameDouble>' for f, v, it, inner in keys)
    return f'<KeyedProperty property="{prop}">{body}</KeyedProperty>'


WAVE_WRIST = [(0, 0.0), (10, 0.0), (22, -0.1), (32, -0.2), (42, -0.35), (52, 0.1), (62, -0.35), (72, -0.2), (84, -0.05), (98, 0.0), (108, 0.0)]
WAVE_LEAN = [(0, 0.0), (10, 0.0), (22, -0.06), (32, -0.15), (42, -0.21), (52, -0.21), (62, -0.21), (72, -0.17), (84, -0.06), (98, 0.0), (108, 0.0)]
FORE_REST = {"l": 1.668022, "r": 1.473571}
FORE_ID = {"l": "0:9215", "r": "0:9221"}
FORE_BIND = {"l": (-0.097072, 0.995277, -0.995277, -0.097072), "r": (0.097072, 0.995277, -0.995277, 0.097072)}  # same as the cuff fore tendon
FORE_LOCAL = {"l": (-25.4, 215.5), "r": (25.4, 215.5)}


def repivot_hand_keys(scene: str, side: str, hc: dict, delta: tuple[float, float]) -> tuple[str, int]:
    """re-express every hand x/y/rotation track for a hand bone whose origin moved by ``delta`` (rest, hand frame)."""
    hid = hc["hand_id"]
    t0 = hc["hand_local"]
    n = 0

    def fix(match: re.Match) -> str:
        nonlocal n
        name = match.group(1)
        body = match.group(2)
        blocks = list(re.finditer(rf'[ \t]*<KeyedObject objectId="{re.escape(hid)}">(.*?)</KeyedObject>\s*', body, re.S))
        if not blocks:
            return match.group(0)
        merged = "".join(b.group(1) for b in blocks)
        kx, ky, kr = parse_track(merged, "x"), parse_track(merged, "y"), parse_track(merged, "rotation")
        if name == "full.wave" and side == "r":
            # the hand now rides the forearm (wrist pivot) instead of the old upside-down counter-rotation, and the
            # forearm leans a little inward at the peak so cuff + hand stay inside the 960px artboard
            fm = re.search(rf'<KeyedObject objectId="{FORE_ID[side]}">(.*?)</KeyedObject>', body, re.S)
            kf = parse_track(fm.group(1), "rotation")
            kfx, kfy = parse_track(fm.group(1), "x"), parse_track(fm.group(1), "y")
            it, inner = kr[0][2], kr[0][3]
            lean = dict(WAVE_LEAN)
            new_fore = [(f, v + lean.get(f, 0.0), i_, in_) for f, v, i_, in_ in kf]
            body_new = body[: fm.start(1)] + emit_track("x", kfx) + emit_track("y", kfy) + emit_track("rotation", new_fore) + body[fm.end(1):]
            body = body_new
            blocks = list(re.finditer(rf'[ \t]*<KeyedObject objectId="{re.escape(hid)}">(.*?)</KeyedObject>\s*', body, re.S))
            wr = dict(WAVE_WRIST)
            kr = [(f, (v - FORE_REST[side]) + wr.get(f, 0.0), it, inner) for f, v, _, _ in new_fore]
            l2 = math.hypot(hc["hand_local"][0] - 25.4, hc["hand_local"][1] - 215.5)
            kx = [(f, sample(kfx, f, 25.4) + l2 * math.cos(v), it, inner) for f, v, _, _ in new_fore]
            ky = [(f, sample(kfy, f, 215.5) + l2 * math.sin(v), it, inner) for f, v, _, _ in new_fore]
        frames = sorted({f for f, *_ in kx + ky + kr})
        src = (kr or kx or ky)[0]
        it, inner = src[2], src[3]
        nx, ny = [], []
        for f in frames:
            x = sample(kx, f, t0[0])
            y = sample(ky, f, t0[1])
            r = sample(kr, f, 0.0)
            c, s_ = math.cos(r), math.sin(r)
            nx.append((f, x + c * delta[0] - s_ * delta[1], it, inner))
            ny.append((f, y + s_ * delta[0] + c * delta[1], it, inner))
        nr = [(f, sample(kr, f, 0.0), it, inner) for f in frames]
        new = (f'            <KeyedObject objectId="{hid}">' + emit_track("x", nx) + emit_track("y", ny)
               + emit_track("rotation", nr) + "</KeyedObject>\n")
        first = blocks[0]
        out = body[: first.start()] + new
        last_end = first.end()
        for b in blocks[1:]:
            out += body[last_end: b.start()]
            last_end = b.end()
        out += body[last_end:]
        # remaining blocks removed; keep text between them
        n += 1
        return match.group(0)[: match.start(2) - match.start(0)] + out + match.group(0)[match.end(2) - match.start(0):]

    scene2 = re.sub(r'(?s)<LinearAnimation name="([^"]*)"[^>]*>(.*?)</LinearAnimation>', fix, scene)
    return scene2, n


def main() -> None:
    scene = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{PIN_R8}:rive/nomi-complete/scene.rml"]).decode("utf-8")
    meta = json.loads(L9.META.read_text())
    used = [int(m.split(':')[1]) for m in re.findall(r'\bid="(0:\d+)"', scene)]
    mx = max(used) + 1
    R8._next['mesh'] = mx
    R8._next['image'] = mx + 5000
    stats = {"images": 0, "bones": 0}
    for side, hc in HANDS.items():
        rig = hc["rig"]
        # --- re-pivot the hand bone from the forearm tip (38px off the drawn wrist) to the real wrist
        w_art = R8.art(*RIG.WRIST[side])
        w_local = (w_art[0] - rig[0], w_art[1] - rig[1])
        delta = (w_local[0] - hc["hand_local"][0], w_local[1] - hc["hand_local"][1])

        def shift_tendon(m: re.Match, delta=delta) -> str:
            tx = float(m.group(2)) + delta[0]
            ty = float(m.group(4)) + delta[1]
            return f'{m.group(1)}{tx:.4f}{m.group(3)}{ty:.4f}"'

        scene, n_t = re.subn(rf'(<Tendon boneId="{re.escape(hc["hand_id"])}"[^>]*? tx=")([^"]*)(" ty=")([^"]*)"', shift_tendon, scene)
        scene = re.sub(rf'(<RootBone name="full\.arm-{side}\.hand" )x="[^"]*" y="[^"]*"',
                       lambda m: f'{m.group(1)}x="{w_local[0]:.4f}" y="{w_local[1]:.4f}"', scene, count=1)
        scene, n_k = repivot_hand_keys(scene, side, hc, delta)
        print(f"  {side}: wrist pivot {w_local[0]:.1f},{w_local[1]:.1f} (delta {delta[0]:.1f},{delta[1]:.1f}); tendons shifted {n_t}; animations rewritten {n_k}")
        hc["hand_local"] = w_local
        hand_abs = w_art
        # --- drop palm + 5 finger Images
        scene = R8.remove_elem(scene, "Image", hc["palm"])
        for part in PARTS:
            scene = R8.remove_elem(scene, "Image", f"full.hand-{side}.{part}.image")
        # --- assets: palm asset becomes the single hand asset, finger assets go away
        scene = scene.replace(
            f'<ImageAsset name="fullbody-hand-{side}-palm" file="reference/svg-rig/hand-{side}-palm.png" id="{hc["asset"]}"/>',
            f'<ImageAsset name="fullbody-hand-{side}" file="reference/svg-rig/hand-{side}.png" id="{hc["asset"]}"/>')
        for aid in hc["drop_assets"]:
            scene = re.sub(rf'\s*<ImageAsset name="[^"]*" file="[^"]*" id="{re.escape(aid)}"/>', "", scene)
        # --- skeleton at the real joints (rest rotation 0, everything nested in the hand bone)
        bones = [(hc["hand_id"], hc["hand_local"])]
        chains = {}
        for part in PARTS:
            pts = [R8.art(*p) for p in RIG.JOINTS[side][part]["pts"]]            # artboard px
            j0, j1, j2 = pts[0], pts[1], pts[2]
            name = f"full.arm-{side}.{part}"
            b2 = R8.bone(f"{name}.2", j2[0] - j1[0], j2[1] - j1[1], hc["p2"][part])
            b1 = R8.bone(f"{name}.1", j1[0] - j0[0], j1[1] - j0[1], hc["p1"][part], b2)
            b0 = R8.bone(name, j0[0] - hand_abs[0], j0[1] - hand_abs[1], hc["roots"][part], b1)
            scene = R8.replace_elem(scene, "RootBone", name, b0)
            bones += [(hc["roots"][part], (j0[0] - rig[0], j0[1] - rig[1])),
                      (hc["p1"][part], (j1[0] - rig[0], j1[1] - rig[1])),
                      (hc["p2"][part], (j2[0] - rig[0], j2[1] - rig[1]))]
        bones.append((FORE_ID[side], FORE_LOCAL[side], FORE_BIND[side]))   # tendon 16: forearm (wrist rows ride the cuff band)
        # --- one continuous Mesh over the single hand crop
        hb = meta["boxes"][f"hand-{side}"]
        png = Image.open(OUT / f"hand-{side}.png")

        def wfn(x: float, y: float, side=side, rig=rig) -> list[float]:
            mx = (x + rig[0] - OX) / S
            my = (y + rig[1] - OY) / S
            return RIG.weights_at(side, mx, my)

        ax, ay = R8.art(hb[0], hb[1])
        mesh = grid_mesh9(f"full.hand-{side}", (ax - rig[0], ay - rig[1]), png.size, 2.2, wfn, bones)
        img = (f'<Image name="full.hand-{side}.image" assetId="{hc["asset"]}" x="0" y="0" originX="0" originY="0" '
               f'scaleX="1" scaleY="1" id="{R8.nid("image")}">{mesh}</Image>')
        scene = R8.insert_after(scene, "RootBone", f"full.arm-{side}.hand", img)
        stats["images"] -= 5
        stats["bones"] += 0
    scene = scene.replace("<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND8:",
                          "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND9: one skinned Mesh per hand, finger skeleton at the real joints -->\n    <!-- ROUND8:", 1)
    SCENE.write_text(scene, encoding="utf-8")

    # ---- license / sha
    data = json.loads(LICENSE.read_text())
    assets = data["assets"]
    for side in "lr":
        for part in ("palm",) + PARTS:
            assets.pop(f"reference/svg-rig/hand-{side}-{part}.png", None)
    touched = [f"hand-{s}" for s in "lr"] + [f"arm-{s}-cuff" for s in "lr"] + [f"hem-ribbon-{s}" for s in "lr"]
    touched += ["fullbody-base-no-head-arms"]
    touched += [f"sleeve-{s}-{k}" for s in "lr" for k in ("lower", "lower-dark", "lower-orange", "full", "full-dark", "bent")]
    for stem in touched:
        rel = f"reference/svg-rig/{stem}.png"
        p = PROJECT / rel
        if not p.exists():
            continue
        assets[rel] = {"sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size, "ai_generated": False,
                       "in_scene": True, "method": "deterministic source-pixel rig layer derived from user supplied full-body mother"}
    note = data.get("note", "")
    # collapse the accumulated duplicate ROUND8 notes once, then add ROUND9
    note = re.sub(r"(ROUND8: vest/shorts/belt-band, continuous leg skin and tight finger crops, all cut from the mother pixels\.\s*)+",
                  "ROUND8: vest/shorts/belt-band, continuous leg skin, all cut from the mother pixels. ", note)
    if "ROUND9" not in note:
        note = (note + " ROUND9: one continuous hand crop per side (wrist+palm+thumb+fingers cut once from the mother, "
                "skinned to a finger skeleton); hand/ribbon/thigh pixels removed from cuff, sleeve and hem crops.").strip()
    data["note"] = note
    LICENSE.write_text(json.dumps(data, indent=2) + "\n")
    print("ROUND9 scene patched", stats)


if __name__ == "__main__":
    main()
