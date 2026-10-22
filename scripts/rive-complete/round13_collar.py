#!/usr/bin/env python3
"""ROUND13 item 3 — collar / neck: the body pixels that rode on the head and neck bones are skinned back to the torso.

Root cause (REPORT-ROUND13.md): three R7 crops in the head/neck group carry torso art, so every head turn (neck rotates
up to 0.24 rad about mother (512, 300)) swung the shoulders, jacket collar, straps and chest with the head:
  * head.png [250,0,780,370]  - face + jaw hair + choker + neck + shoulders + jacket collar + straps + chest/logo strip
  * "mouth.png" [450,250,575,310] - actually the collarbone / neck skin patch (+ pendant hole), on full.mouth (not keyed)
  * "choker.png" [435,305,585,360] - actually the tank-top neckline with the orange star, on full.choker (neck child)
Fix (no pixel changes, so the rest pose is identical): the three images become skinned meshes with tendons
[full.head, full.torso].  Weight field in mother px:
  * above the chin (my <= 222) -> head;
  * neck column (|mx-512| < 50, fading out by 80): head share ramps 1 -> 0 from the chin to the neck pivot (my 300),
    so the choker wraps the neck and the neck skin bends instead of shearing;
  * outside the column: head down to my 250 (jaw-side hair strands), torso from my 258 (jacket collar, shoulders);
  * tank neckline: torso only.
  * the loose hair-l strand tip lying on the left shoulder (mother y 276-307, 137 px) moves out of hair-l into
    hair-tip-l.png, skinned to the torso at the same draw depth: it rests on the shoulder, so it stays on the shoulder
    (rigid with the head it floated in the air beside the now-still shoulder).
Runs after round13_hair.py."""
from __future__ import annotations

import hashlib
import json
import re

import numpy as np
from PIL import Image

import round8_scene as R8
import round13_anim as A
import round10_layers as L10

PROJECT = L10.PROJECT
SCENE = PROJECT / "scene.rml"
S = R8.S
TORSO = (480.0, 660.0)
HEAD = (480.0, 253.9)
CX, CHIN, PIVOT_Y = 512.0, 222.0, 300.0
COL_IN, COL_OUT = 50.0, 80.0
SIDE_HI, SIDE_LO = 250.0, 258.0


def w_head(mx: float, my: float) -> float:
    sm = R8.smooth01
    neck = sm((PIVOT_Y - my) / (PIVOT_Y - CHIN))
    col = 1.0 - sm((abs(mx - CX) - COL_IN) / (COL_OUT - COL_IN))
    side = sm((SIDE_LO - my) / (SIDE_LO - SIDE_HI))
    return neck * col + side * (1.0 - col)


def rows(box, dense=(200.0, 310.0), fine=4.0, coarse=12.0):
    """row edges (v fractions): coarse outside the neck band, `fine` mother px inside it"""
    y0, y1 = box[1], box[3]
    ys, y = [float(y0)], float(y0)
    while y < y1:
        y += fine if dense[0] <= y < dense[1] else coarse
        ys.append(min(y, float(y1)))
    return [(v - y0) / (y1 - y0) for v in ys]


def replace_image(scene, name, box, origin, bones, weight_fn, cell):
    m = re.search(rf'<Image name="{re.escape(name)}"[^>]*?(/>|></Image>)', scene)
    tag = m.group(0)
    img_id = re.search(r' id="([^"]+)"', tag).group(1)
    asset = re.search(r'assetId="([^"]+)"', tag).group(1)
    ox, oy = origin
    def wf(x, y):
        mx, my = (x + ox - R8.OX) / S, (y + oy - R8.OY) / S
        return weight_fn(mx, my)
    xml = R8.image_mesh(name, asset, box, cell, wf, bones, parent_origin=origin, row_edges=rows(box))
    xml = re.sub(r'^(<Image [^>]*?) id="[^"]+">', lambda q: f'{q.group(1)} id="{img_id}">', xml, count=1)
    return scene[:m.start()] + xml + scene[m.end():]


TIP_Y = 266


def split_tip(boxes):
    """move hair-l pixels at mother y >= TIP_Y into hair-tip-l.png; returns (box, px)"""
    out = L10.OUT
    b = boxes["hair-l"]
    a = np.array(Image.open(out / "hair-l.png").convert("RGBA"))
    sel = np.zeros(a.shape[:2], bool)
    sel[max(0, TIP_Y - b[1]):] = True
    sel &= a[..., 3] > 0
    ys, xs = np.where(sel)
    if not len(ys):
        return None, 0
    y0, y1, x0, x1 = ys.min() - 2, ys.max() + 3, xs.min() - 2, xs.max() + 3
    tip = np.where(sel[..., None], a, 0).astype(np.uint8)[y0:y1, x0:x1]
    a[sel] = 0
    Image.fromarray(a).save(out / "hair-l.png")
    Image.fromarray(tip).save(out / "hair-tip-l.png")
    return [int(b[0] + x0), int(b[1] + y0), int(b[0] + x1), int(b[1] + y1)], int(sel.sum())


def main():
    scene = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    boxes = json.loads(L10.META.read_text())["boxes"]
    hd, tq = ids["full.head"], ids["full.torso"]
    rep = {}
    # head.png under full.head (origin = head world at rest)
    o = HEAD
    scene = replace_image(scene, "full.head.image", boxes["head"], o,
                          [(hd, (0.0, 0.0)), (tq, (TORSO[0] - o[0], TORSO[1] - o[1]))],
                          lambda mx, my: [w_head(mx, my), 1 - w_head(mx, my)], (10.0, 10.0))
    # neck/collarbone patch ("mouth.png") under full.mouth (head-local 0,-93)
    o = (HEAD[0], HEAD[1] - 93.0)
    scene = replace_image(scene, "full.mouth.image", boxes["mouth"], o,
                          [(hd, (HEAD[0] - o[0], HEAD[1] - o[1])), (tq, (TORSO[0] - o[0], TORSO[1] - o[1]))],
                          lambda mx, my: [w_head(mx, my), 1 - w_head(mx, my)], (6.0, 6.0))
    # tank neckline ("choker.png") under full.choker (neck-local 0,40): torso only
    o = (HEAD[0], HEAD[1] + 40.0)
    scene = replace_image(scene, "full.choker.image", boxes["choker"], o,
                          [(tq, (TORSO[0] - o[0], TORSO[1] - o[1]))], lambda mx, my: [1.0], (24.0, 24.0))
    # loose strand tip -> torso, same draw depth as hair-l (just in front of its bone)
    tb, tpx = split_tip(boxes)
    if tb:
        boxes["hair-tip-l"] = tb
        aid = R8.nid("asset")
        scene = scene.replace('<ImageAsset name="fullbody-hair-bow"',
                              f'<ImageAsset name="fullbody-hair-tip-l" file="reference/svg-rig/hair-tip-l.png" id="{aid}"/>\n    <ImageAsset name="fullbody-hair-bow"', 1)
        o = HEAD
        tip = R8.image_mesh("full.hair.tip.l.image", aid, tb, (40.0, 40.0), lambda x, y: [1.0],
                            [(tq, (TORSO[0] - o[0], TORSO[1] - o[1]))], parent_origin=o)
        i = scene.index('<RootBone name="full.hair.l"')
        i = scene.rfind("\n", 0, i) + 1
        scene = scene[:i] + "                        " + tip + "\n" + scene[i:]
        rep["hair-tip-l"] = {"box": tb, "px": tpx}
        txt = L10.META.read_text()
        if '"hair-tip-l"' not in txt:
            txt = re.sub(r'(\n\s*)("hair-bow": )', lambda q: f'{q.group(1)}"hair-tip-l": {tb},{q.group(1)}{q.group(2)}', txt, count=1)
        json.loads(txt)
        L10.META.write_text(txt)
        lic_p = PROJECT / "parts" / "DETAIL_LICENSE.json"
        lic = json.loads(lic_p.read_text())
        for nme in ("hair-l", "hair-tip-l"):
            rel = f"reference/svg-rig/{nme}.png"
            pth = PROJECT / rel
            e = lic["assets"].get(rel) or {}
            e.update(sha256=hashlib.sha256(pth.read_bytes()).hexdigest(), bytes=pth.stat().st_size, ai_generated=False, in_scene=True,
                     method=e.get("method", "deterministic source-pixel rig layer derived from user supplied full-body mother"))
            lic["assets"][rel] = e
        note = lic.get("note", "")
        if "ROUND13 collar" not in note:
            lic["note"] = (note + " ROUND13 collar: hair-l strand tip on the shoulder moved (not copied) into hair-tip-l.").strip()
        lic_p.write_text(json.dumps(lic, indent=2) + "\n")
    if "ROUND13 collar" not in scene:
        scene = scene.replace("<!-- ROUND7-FULL-DECOMPOSE -->\n",
                              "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND13 collar: head/neck-group body pixels skinned to torso -->\n", 1)
    SCENE.write_text(scene, encoding="utf-8")
    for n in ("full.head.image", "full.mouth.image", "full.choker.image"):
        m = re.search(rf'<Image name="{re.escape(n)}".*?</Image>', scene, re.S)
        rep[n] = m.group(0).count("<MeshVertex") + m.group(0).count("<ContourMeshVertex")
    print("ROUND13 collar vertices", json.dumps(rep))


if __name__ == "__main__":
    main()
