#!/usr/bin/env python3
"""ROUND13 item 4 — shorts side seams follow the thighs; hip pivots moved to the hip joints.

Root cause (REPORT-ROUND13.md):
  * full.leg-{l,r}.upper sat at mother y 780 - on the thigh strap, ~55 px BELOW the shorts hem (y ~722) - so a thigh
    rotation swung the skin under the hem the wrong way and the hem never moved: the shorts were one rigid crop on
    full.pelvis while the thighs turned inside them.
Fix:
  * hip pivots -> mother (448, 690) / (566, 690) (crotch level, inside the shorts); knee/ankle world positions unchanged
    (child offsets and the leg-skin bind of the upper tendon follow), hop thigh keys scaled by the lever ratio so the
    knees travel the same arc as before.
  * shorts.png becomes a skinned mesh, tendons [pelvis, leg-l.upper, leg-r.upper]: waist/belt/flap rows stay on the
    pelvis, the leg openings blend to their thigh from mother y 660 down to the hem (y 722), split left/right across the
    crotch line (x 505).  No pixel changes.
Runs right after round10_build.sh (before round13_hem.py, which bakes the ribbon thigh-push from the hop keys)."""
from __future__ import annotations

import json
import re

import round8_scene as R8
import round13_anim as A
import round10_layers as L10

PROJECT = L10.PROJECT
SCENE = PROJECT / "scene.rml"
S = R8.S
HIP_OLD_Y, HIP_NEW_Y, KNEE_Y = 780.0, 690.0, 985.0
HIP_X = {"l": 448.0, "r": 566.0}
PELVIS = (480.0, 610.0)
W_TOP, W_HEM, CROTCH_X, CROTCH_W = 660.0, 722.0, 505.0, 16.0


def set_attr(tag, k, v):
    return re.sub(rf' {k}="[^"]*"', f' {k}="{v:.4f}"', tag, count=1)


def main():
    scene = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    boxes = json.loads(L10.META.read_text())["boxes"]
    rep = {"hips": {}}
    dy = (HIP_NEW_Y - HIP_OLD_Y) * S                                        # art px (negative: up)
    for side in "lr":
        pre = f"full.leg-{side}"
        for nm, sgn in ((f"{pre}.upper", 1), (f"{pre}.knee", -1), (f"{pre}.lower", -1)):
            m = re.search(rf'<RootBone name="{re.escape(nm)}"[^>]*>', scene)
            tag = m.group(0)
            y = float(re.search(r' y="([^"]+)"', tag).group(1))
            scene = scene[:m.start()] + set_attr(tag, "y", y + sgn * dy) + scene[m.end():]
        hx, hy = R8.art(HIP_X[side], HIP_NEW_Y)
        uid = ids[f"{pre}.upper"]
        scene, n = re.subn(rf'(<Tendon boneId="{uid}"[^>]*? tx=")[^"]*(" ty=")[^"]*(" name="full\.leg\.{side}\.skin\.image\.t0")',
                           lambda q: f'{q.group(1)}{hx:.4f}{q.group(2)}{hy:.4f}{q.group(3)}', scene)
        assert n == 1, side
        rep["hips"][side] = [round(hx, 2), round(hy, 2)]
    # hop: keep the knee arc (lever ratio)
    ratio = (KNEE_Y - HIP_OLD_Y) / (KNEE_Y - HIP_NEW_Y)
    a, b = R8.find_elem(scene, "LinearAnimation", "full.hop")
    hop = scene[a:b]
    for side in "lr":
        uid = ids[f"full.leg-{side}.upper"]
        km = re.search(rf'<KeyedObject objectId="{uid}">.*?</KeyedObject>', hop, re.S)
        seg = re.sub(r'(<KeyFrameDouble value=")([^"]+)(")', lambda q: f'{q.group(1)}{float(q.group(2)) * ratio:.6f}{q.group(3)}', km.group(0))
        hop = hop[:km.start()] + seg + hop[km.end():]
    scene = scene[:a] + hop + scene[b:]
    rep["hop_upper_scale"] = round(ratio, 4)
    # shorts -> skinned on pelvis + both thighs
    m = re.search(r'<Image name="full\.shorts\.image"[^>]*?(/>|></Image>)', scene)
    tag = m.group(0)
    img_id = re.search(r' id="([^"]+)"', tag).group(1)
    asset = re.search(r'assetId="([^"]+)"', tag).group(1)
    box = boxes["shorts"]
    o = PELVIS
    sm = R8.smooth01

    def wf(x, y):
        mx, my = (x + o[0] - R8.OX) / S, (y + o[1] - R8.OY) / S
        w = sm((my - W_TOP) / (W_HEM - W_TOP))
        sl = 1.0 - sm((mx - (CROTCH_X - CROTCH_W / 2)) / CROTCH_W)
        return [1.0 - w, w * sl, w * (1.0 - sl)]
    bones = [(ids["full.pelvis"], (0.0, 0.0))]
    for side in "lr":
        hx, hy = R8.art(HIP_X[side], HIP_NEW_Y)
        bones.append((ids[f"full.leg-{side}.upper"], (hx - o[0], hy - o[1])))
    y0, y1 = box[1], box[3]
    ys, y = [float(y0)], float(y0)
    while y < y1:
        y += 5.0 if W_TOP - 10 <= y < y1 else 16.0
        ys.append(min(y, float(y1)))
    xml = R8.image_mesh("full.shorts.image", asset, box, (8.0, 8.0), wf, bones, parent_origin=o,
                        row_edges=[(v - y0) / (y1 - y0) for v in ys])
    xml = re.sub(r'^(<Image [^>]*?) id="[^"]+">', lambda q: f'{q.group(1)} id="{img_id}">', xml, count=1)
    scene = scene[:m.start()] + xml + scene[m.end():]
    rep["shorts_verts"] = xml.count("<MeshVertex") + xml.count("<ContourMeshVertex")
    SCENE.write_text(scene, encoding="utf-8")
    print("ROUND13 legs", json.dumps(rep))


if __name__ == "__main__":
    main()
