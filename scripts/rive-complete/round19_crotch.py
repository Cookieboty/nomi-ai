#!/usr/bin/env python3
"""ROUND19 Task C — hop crotch wedge fix (same root cause as R18 squat).

Root cause (REPORT-ROUND18.md §4):
  R13 shorts mesh blends every vertex below mother y 660 to its thigh, split at the crotch line
  (x 505), ~57 px INBOARD of each hip pivot (448 / 566, y 690).  A knee-out thigh rotation a swings
  those inboard vertices down by ~57*sin(a); the two thighs pull the seam apart -> a pointed dark
  wedge under the crotch.  Hop peaks at ~0.111 rad, so the wedge is obvious at f9/f33.

R18 rejected handing crotch weights to the pelvis *and* deleting leg-skin under the shorts (crop
cuts then flashed as spikes).  This round keeps the leg-skin pixels and only reweights the shorts:
  every vertex between the hip pivots (the inboard band) stays on the pelvis even at the hem; outer
  leg openings still follow their thighs.  Also eases hop thigh abduction (0.111 -> ~0.055) and adds
  a little thigh foreshortening so the hop still reads as a tuck without stressing the gusset.
  Idempotent.  No PNG changes.
"""
from __future__ import annotations

import json
import re

import round8_scene as R8
import round13_anim as A
import round10_layers as L10

PROJECT = L10.PROJECT
SCENE = PROJECT / "scene.rml"
S = R8.S
HIP_NEW_Y = 690.0
HIP_X = {"l": 448.0, "r": 566.0}
PELVIS = (480.0, 610.0)
W_TOP, W_HEM, CROTCH_X, CROTCH_W = 660.0, 722.0, 505.0, 16.0
BRIDGE_KEEP = 1.00
HOP_ABDUCT_SCALE = 0.50
HOP_FORE_MAX = 0.92


def rebuild_shorts(scene: str) -> tuple[str, dict]:
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    boxes = json.loads(L10.META.read_text())["boxes"]
    m = re.search(r'<Image name="full\.shorts\.image"[^>]*?(/>|>(?:(?!</Image>).)*</Image>)', scene, re.S)
    assert m, "shorts image missing"
    tag_head = re.search(r'<Image name="full\.shorts\.image"[^>]*>', m.group(0)).group(0)
    img_id = re.search(r' id="([^"]+)"', tag_head).group(1)
    asset = re.search(r'assetId="([^"]+)"', tag_head).group(1)
    box = boxes["shorts"]
    o = PELVIS
    sm = R8.smooth01

    def wf(x, y):
        mx, my = (x + o[0] - R8.OX) / S, (y + o[1] - R8.OY) / S
        w = sm((my - W_TOP) / (W_HEM - W_TOP))
        sl = 1.0 - sm((mx - (CROTCH_X - CROTCH_W / 2)) / CROTCH_W)
        inside = sm((mx - (HIP_X["l"] - 10)) / 14.0) * sm(((HIP_X["r"] + 10) - mx) / 14.0)
        thigh = w * (1.0 - BRIDGE_KEEP * inside)
        return [1.0 - thigh, thigh * sl, thigh * (1.0 - sl)]

    bones = [(ids["full.pelvis"], (0.0, 0.0))]
    for side in "lr":
        hx, hy = R8.art(HIP_X[side], HIP_NEW_Y)
        bones.append((ids[f"full.leg-{side}.upper"], (hx - o[0], hy - o[1])))
    y0, y1 = box[1], box[3]
    ys, y = [float(y0)], float(y0)
    while y < y1:
        y += 5.0 if W_TOP - 10 <= y < y1 else 16.0
        ys.append(min(y, float(y1)))
    xml = R8.image_mesh(
        "full.shorts.image", asset, box, (8.0, 8.0), wf, bones, parent_origin=o,
        row_edges=[(v - y0) / (y1 - y0) for v in ys],
    )
    xml = re.sub(r'^(<Image [^>]*?) id="[^"]+">', lambda q: f'{q.group(1)} id="{img_id}">', xml, count=1)
    scene = scene[: m.start()] + xml + scene[m.end() :]
    samples = {}
    for label, mx, my in [
        ("midline_hem", CROTCH_X, W_HEM),
        ("hipL_hem", HIP_X["l"], W_HEM),
        ("justInsideL", HIP_X["l"] + 20, W_HEM),
        ("outerL_hem", 420.0, W_HEM),
        ("waist_mid", CROTCH_X, W_TOP),
    ]:
        ax, ay = R8.art(mx, my)
        samples[label] = [round(v, 3) for v in wf(ax - o[0], ay - o[1])]
    return scene, {"verts": xml.count("<MeshVertex") + xml.count("<ContourMeshVertex"), "samples": samples}


def ease_hop(scene: str) -> tuple[str, dict]:
    ids = A.ids_by_name(scene)
    a, b = R8.find_elem(scene, "LinearAnimation", "full.hop")
    hop = scene[a:b]
    report = {"upper_rot_scale": HOP_ABDUCT_SCALE, "fore_max": HOP_FORE_MAX, "peaks": {}}
    # idempotent: detect if already scaled by checking peak ~0.055
    for side in "lr":
        uid = ids[f"full.leg-{side}.upper"]
        lid = ids[f"full.leg-{side}.lower"]
        km = re.search(rf'<KeyedObject objectId="{uid}">.*?</KeyedObject>', hop, re.S)
        assert km, side
        seg = km.group(0)
        rm = re.search(r'<KeyedProperty property="rotation">.*?</KeyedProperty>', seg, re.S)
        kfs = [(int(m.group(2)), float(m.group(1))) for m in re.finditer(
            r'<KeyFrameDouble value="([^"]+)" frame="(\d+)"', rm.group(0))]
        peak0 = max(abs(v) for _, v in kfs) or 1e-6
        # only scale if still at original magnitude (~0.11)
        already = peak0 < 0.08
        if already:
            scaled = list(kfs)
            scale_applied = 1.0
        else:
            scaled = [(f, v * HOP_ABDUCT_SCALE) for f, v in kfs]
            scale_applied = HOP_ABDUCT_SCALE

            def repl_rot(m):
                v = float(m.group(2)) * HOP_ABDUCT_SCALE
                return f'{m.group(1)}{v:.6f}{m.group(3)}'

            rot = re.sub(r'(<KeyFrameDouble value=")([^"]+)(")', repl_rot, rm.group(0))
            seg = seg[: rm.start()] + rot + seg[rm.end() :]
        report["peaks"][side] = round(max(abs(v) for _, v in scaled), 5)
        peak = max(abs(v) for _, v in scaled) or 1e-6
        sy_frames = []
        for f, v in scaled:
            t = abs(v) / peak
            sy_frames.append((f, 1.0 - (1.0 - HOP_FORE_MAX) * t))
        seg = re.sub(r'\s*<KeyedProperty property="scaleY">.*?</KeyedProperty>', "", seg, flags=re.S)
        sy_body = "".join(
            f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="cubic">'
            f'<CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/></KeyFrameDouble>'
            for f, v in sy_frames
        )
        seg = seg.replace(
            "</KeyedObject>",
            f'<KeyedProperty property="scaleY">{sy_body}</KeyedProperty></KeyedObject>',
            1,
        )
        hop = hop[: km.start()] + seg + hop[km.end() :]
        # lower.scaleY inverse
        inv_body = "".join(
            f'<KeyFrameDouble value="{1.0 / v:.6f}" frame="{f}" interpolationType="cubic">'
            f'<CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/></KeyFrameDouble>'
            for f, v in sy_frames
        )
        km_l = re.search(rf'<KeyedObject objectId="{lid}">.*?</KeyedObject>', hop, re.S)
        if km_l:
            lseg = re.sub(r'\s*<KeyedProperty property="scaleY">.*?</KeyedProperty>', "", km_l.group(0), flags=re.S)
            lseg = lseg.replace(
                "</KeyedObject>",
                f'<KeyedProperty property="scaleY">{inv_body}</KeyedProperty></KeyedObject>',
                1,
            )
            hop = hop[: km_l.start()] + lseg + hop[km_l.end() :]
        else:
            insert = (
                f'<KeyedObject objectId="{lid}"><KeyedProperty property="scaleY">{inv_body}'
                f"</KeyedProperty></KeyedObject>"
            )
            hop = hop.replace("</LinearAnimation>", insert + "</LinearAnimation>", 1)
        report["scale_applied"] = scale_applied
    scene = scene[:a] + hop + scene[b:]
    return scene, report


def main():
    scene = SCENE.read_text(encoding="utf-8")
    scene, shorts = rebuild_shorts(scene)
    scene, hop = ease_hop(scene)
    if "ROUND19 crotch" not in scene:
        scene = scene.replace(
            "<!-- ROUND7-FULL-DECOMPOSE -->\n",
            "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND19 crotch: shorts inter-hip bridge + eased hop abduct -->\n",
            1,
        )
    SCENE.write_text(scene, encoding="utf-8")
    print("ROUND19 crotch", json.dumps({"shorts": shorts, "hop": hop}))


if __name__ == "__main__":
    main()
