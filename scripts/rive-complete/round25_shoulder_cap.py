#!/usr/bin/env python3
"""ROUND25c - take the shoulder caps OUT of head.png and put them on the skinned shoulder-skin pieces.

Root cause of the 'folded shoulder' in wave/cheer: reference/svg-rig/head.png (head+neck+chest crop, skinned to
full.head/full.torso, drawn ABOVE every arm piece) also contains both bare deltoid caps (screen y 235-312) and a bit of
lapel.  Whatever the arm bones did, a frozen copy of the shoulder dome stayed pinned to the torso on top of the
raised arm -> the vertical cap + horizontal arm read as a sharp fold at the armpit/deltoid.
Fix: every head.png pixel in the arm-side shoulder box (r: x>=548, l: x<=412.6, y>=226 screen) that is not under an
intermediate layer drawn between head and the shoulder pieces (torso-tank, 4 px dilated so the cut stays off the strap edge; the hair-tip-l
end tucked behind the left cap is moved too, see REPORT-ROUND25) is
composited 1:1 (head OVER skin, same screen position; the skin mesh is shifted <1 px so its texel grid matches
head.png, no resampling of the cap; +2 px border copy against filtering seams) into
arm-X-shoulder-skin.png and deleted from head.png.
Draw order head > shoulder-skin > stump/coat is unchanged for those pixels, so rest is visually identical; the cap
now rides the R25 shoulder/upper bones.  Idempotent: second run finds no cap pixels left."""
from __future__ import annotations
import hashlib, json, re
import numpy as np
from PIL import Image
import cv2
import round10_layers as L10

PROJECT = L10.PROJECT
D = PROJECT / "reference/svg-rig"
S = 0.8463541666666666
MID = L10.ROOT / "scripts/rive-complete/round13/mid-cover-idle-r25.png"   # union of idle coverage of layers between head and shoulder pieces


def rect(scene, nm):
    i = scene.find(f'<Image name="{nm}"'); j = scene.find("</Image>", i)
    v = [(float(a), float(b)) for a, b in re.findall(r'MeshVertex x="([-\d.]+)" y="([-\d.]+)" u="0.000000" v="0.000000"', scene[i:j])]
    return v[0]


def main():
    scene = (PROJECT / "scene.rml").read_text()
    hx0, hy0 = rect(scene, "full.head.image"); hx0 += 480.0; hy0 += 660.0 - 406.1   # head bone world (480,253.9)
    head = np.array(Image.open(D / "head.png").convert("RGBA")).astype(np.float64)
    H, W = head.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W]
    sx, sy = hx0 + xx * S, hy0 + yy * S
    mid = cv2.dilate((np.array(Image.open(MID)) > 0).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    mid_h = mid[np.clip(np.round(sy).astype(int), 0, 1299), np.clip(np.round(sx).astype(int), 0, 959)]
    rep = {}
    for s, box in (("r", sx >= 548.0), ("l", sx <= 412.6)):
        sel = box & (sy >= 226.0) & ~mid_h & (head[..., 3] > 0)
        if not sel.any():
            rep[s] = "already moved"; continue
        kx0, ky0 = rect(scene, f"full.arm-{s}.shoulder-skin.static")
        sp = D / f"arm-{s}-shoulder-skin.png"
        sk = np.array(Image.open(sp).convert("RGBA")).astype(np.float64)
        h2, w2 = sk.shape[:2]
        # align the skin texel grid to the head texel grid (integer offset) so the cap pixels are copied 1:1 with
        # no resampling; only the tiny original skin sliver (hidden under the cap at rest) is shifted sub-pixel.
        fx, fy = (kx0 - hx0) / S, (ky0 - hy0) / S
        ix, iy = int(round(fx)), int(round(fy))
        nx0, ny0 = hx0 + ix * S, hy0 + iy * S
        M = np.float32([[1, 0, fx - ix], [0, 1, fy - iy]])
        pm = sk[..., :3] * sk[..., 3:4] / 255.0
        wa = lambda ch: cv2.warpAffine(ch.astype(np.float32), M, (w2, h2), flags=cv2.INTER_LINEAR,
                                       borderMode=cv2.BORDER_CONSTANT, borderValue=0).astype(np.float64)
        al0 = wa(sk[..., 3]); rgb0 = np.dstack([wa(pm[..., c]) for c in range(3)])
        sk = np.dstack([np.where(al0[..., None] > 0, rgb0 * 255.0 / np.maximum(al0[..., None], 1e-6), 0), al0])
        i0, i1 = scene.find(f'<Image name="full.arm-{s}.shoulder-skin.static"'), None
        i1 = scene.find("</Image>", i0)
        blk = re.sub(r'(<(?:Contour)?MeshVertex x=")([-\d.]+)(" y=")([-\d.]+)(")',
                     lambda q: f"{q.group(1)}{float(q.group(2)) + nx0 - kx0:.4f}{q.group(3)}{float(q.group(4)) + ny0 - ky0:.4f}{q.group(5)}",
                     scene[i0:i1])
        scene = scene[:i0] + blk + scene[i1:]
        # the skin copy keeps a 2 px border of the remaining head pixels (copy, not move) so bilinear filtering at
        # the cut does not open a half-transparent seam at rest (same trick as the R22 lining split).
        cp = (cv2.dilate(sel.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & (head[..., 3] > 0)
        ys, xs = np.nonzero(cp)
        tx, ty = xs - ix, ys - iy
        ok = (tx >= 0) & (tx < w2) & (ty >= 0) & (ty < h2)
        assert ok.all(), "cap pixel outside the shoulder-skin texture"
        src = head[ys, xs]; dst = sk[ty, tx]
        sa = src[:, 3:4] / 255.0; da = dst[:, 3:4] / 255.0
        oa = sa + da * (1 - sa)
        orgb = (src[:, :3] * sa + dst[:, :3] * da * (1 - sa)) / np.maximum(oa, 1e-6)
        sk[ty, tx] = np.hstack([orgb, oa * 255.0])
        Image.fromarray(np.clip(np.round(sk), 0, 255).astype(np.uint8)).save(sp)
        head[sel] = 0
        rep[s] = int(sel.sum())
    Image.fromarray(head.astype(np.uint8)).save(D / "head.png")
    (PROJECT / "scene.rml").write_text(scene)
    lic_p = PROJECT / "parts" / "DETAIL_LICENSE.json"
    lic = json.loads(lic_p.read_text())
    for p in (D / "head.png", D / "arm-r-shoulder-skin.png", D / "arm-l-shoulder-skin.png"):
        rel = f"reference/svg-rig/{p.name}"
        e = lic["assets"].get(rel) or {}
        e.update(sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size)
        lic["assets"][rel] = e
    if "ROUND25" not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " ROUND25: shoulder-cap pixels moved (not copied) from head.png into arm-l/r-shoulder-skin.png (same screen position; deterministic, no AI).").strip()
    lic_p.write_text(json.dumps(lic, indent=2) + "\n")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round25_shoulder_cap" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip() + "\npython3 round25_shoulder_cap.py\n")
    print("cap pixels moved", rep)


if __name__ == "__main__":
    main()
