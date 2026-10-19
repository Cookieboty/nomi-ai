#!/usr/bin/env python3
"""ROUND10 hand pieces -> scene.rml: replace each ``full.hand-<side>.image`` (one continuous Mesh) with 6 disjoint-ish
skinned pieces (palm + 5 fingers, see round10_hand.py).

Order: round10_layers.py -> round10_scene.py -> round10_hand_scene.py -> round10_fist.py (fist clip, optional).
Idempotent when run on a scene that still has ``full.hand-<side>.image`` (git checkout scene.rml first otherwise).
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import subprocess

import numpy as np
from PIL import Image

import round8_scene as R8
import round9_scene as R9
import round10_hand as H
import round10_layers as L10

PROJECT, OUT, ROOT = L10.PROJECT, L10.OUT, L10.ROOT
SCENE = PROJECT / "scene.rml"
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
S, OX, OY = R8.S, R8.OX, R8.OY
PIECES = ("palm",) + H.ORDER


def tendons_for(side: str, piece, hc: dict) -> list:
    """[(bone id, (x, y) in rig space[, matrix])] in the order of piece.bones"""
    rig = hc["rig"]
    out = []
    for b in piece.bones:
        if b == "hand":
            out.append((hc["hand_id"], hc["hand_local"]))
        elif b == "fore":
            out.append((R9.FORE_ID[side], R9.FORE_LOCAL[side], R9.FORE_BIND[side]))
        else:
            nm, i = b
            j = R8.art(*R9.RIG.JOINTS[side][nm]["pts"][i])
            bid = (hc["roots"][nm], hc["p1"][nm], hc["p2"][nm])[i]
            out.append((bid, (j[0] - rig[0], j[1] - rig[1])))
    return out


def piece_mesh(side: str, piece, hc: dict, name: str) -> str:
    rig = hc["rig"]
    verts, tris, ws = H.mesh_of(side, piece)
    # boundary vertices = ends of edges used by exactly one triangle
    cnt: dict = {}
    for t in tris:
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            k = (min(a, b), max(a, b))
            cnt[k] = cnt.get(k, 0) + 1
    bset = {v for (a, b), n in cnt.items() if n == 1 for v in (a, b)}
    order = sorted(bset) + [i for i in range(len(verts)) if i not in bset]
    newi = {o: n for n, o in enumerate(order)}
    tri = bytearray()
    for t in tris:
        for v in t:
            tri += R8.varuint(newi[v])
    parts = [f'<Mesh triangleIndexBytes="{base64.b64encode(bytes(tri)).decode()}" name="{name}.mesh" id="{R8.nid("mesh")}">']
    for i in order:
        mx, my, u, v = verts[i]
        ax, ay = R8.art(mx, my)
        vals, inds = R9.pack4(ws[i])
        kind = "ContourMeshVertex" if i in bset else "MeshVertex"
        parts.append(f'<{kind} x="{ax - rig[0]:.4f}" y="{ay - rig[1]:.4f}" u="{u:.6f}" v="{v:.6f}" name="{name}.v{newi[i]}">'
                     f'<Weight values="{vals}" indices="{inds}"/></{kind}>')
    parts.append(f'<Skin name="{name}.skin" id="{R8.nid("mesh")}" xx="1" xy="0" yx="0" yy="1" tx="0" ty="0">')
    for k, bone in enumerate(tendons_for(side, piece, hc)):
        bid, (bx, by) = bone[0], bone[1]
        xx, xy, yx, yy = bone[2] if len(bone) > 2 else (1.0, 0.0, 0.0, 1.0)
        parts.append(f'<Tendon boneId="{bid}" xx="{xx:.6f}" xy="{xy:.6f}" yx="{yx:.6f}" yy="{yy:.6f}" '
                     f'tx="{bx:.4f}" ty="{by:.4f}" name="{name}.t{k}"/>')
    parts.append("</Skin></Mesh>")
    return "".join(parts)


def main() -> None:
    scene = SCENE.read_text(encoding="utf-8")
    meta_txt = L10.META.read_text()
    meta = json.loads(meta_txt)
    used = [int(m.split(":")[1]) for m in re.findall(r'\bid="(0:\d+)"', scene)]
    mx = max(used) + 1
    R8._next["mesh"] = mx
    R8._next["image"] = mx + 4000
    R8._next["asset"] = mx + 8000
    stats = {"pieces": 0, "tris": 0}
    new_boxes = {}
    for side, hc in R9.HANDS.items():
        # the R9 hand frame: wrist pivot (hand_local after the R9 re-pivot)
        w_art = R8.art(*R9.RIG.WRIST[side])
        hc["hand_local"] = (w_art[0] - hc["rig"][0], w_art[1] - hc["rig"][1])
        P = H.build_pieces(side)
        hb = H.grid(side)[0]
        images, assets = [], []
        for nm in PIECES:
            pc = P[nm]
            fname = f"hand-{side}-{nm}"
            Image.fromarray(pc.tex).save(OUT / f"{fname}.png")
            new_boxes[fname] = list(hb)
            aid = R8.nid("asset")
            assets.append(f'<ImageAsset name="fullbody-{fname}" file="reference/svg-rig/{fname}.png" id="{aid}"/>')
            name = f"full.hand-{side}.{nm}"
            images.append(f'<Image name="{name}.image" assetId="{aid}" x="0" y="0" originX="0" originY="0" '
                          f'scaleX="1" scaleY="1" id="{R8.nid("image")}">{piece_mesh(side, pc, hc, name)}</Image>')
            stats["pieces"] += 1
            stats["tris"] += int(pc.cells.sum()) * 2
        old_asset = f'<ImageAsset name="fullbody-hand-{side}" file="reference/svg-rig/hand-{side}.png" id="{hc["asset"]}"/>'
        assert old_asset in scene, old_asset
        scene = scene.replace(old_asset, "\n    ".join(assets))
        scene = R8.replace_elem(scene, "Image", f"full.hand-{side}.image", "\n".join(images))
        (OUT / f"hand-{side}.png").unlink(missing_ok=True)
    SCENE.write_text(scene, encoding="utf-8")
    # rig-meta: add piece boxes right after the hand boxes (textual, keeps formatting)
    txt = meta_txt
    for k, b in new_boxes.items():
        if f'"{k}"' not in txt:
            side = k.split("-")[1]
            txt = re.sub(rf'(\n\s*)("hand-{side}": )', lambda m: f'{m.group(1)}"{k}": {b},{m.group(1)}{m.group(2)}', txt, count=1)
    json.loads(txt)
    L10.META.write_text(txt)
    # license
    data = json.loads(LICENSE.read_text())
    assets = data["assets"]
    for side in "lr":
        assets.pop(f"reference/svg-rig/hand-{side}.png", None)
        for nm in PIECES:
            rel = f"reference/svg-rig/hand-{side}-{nm}.png"
            p = PROJECT / rel
            assets[rel] = {"sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size, "ai_generated": False,
                           "in_scene": True, "method": "deterministic source-pixel rig layer derived from user supplied full-body mother"}
    note = data.get("note", "")
    if "ROUND10 hand pieces" not in note:
        data["note"] = (note + " ROUND10 hand pieces: palm + 5 finger pieces cut from the single ROUND9 hand crop by capsule "
                        "ownership (hinge/edge overlap <= 2.5px), each skinned only to its own bones.").strip()
    LICENSE.write_text(json.dumps(data, indent=2) + "\n")
    print("ROUND10 hand pieces", stats)


if __name__ == "__main__":
    main()
